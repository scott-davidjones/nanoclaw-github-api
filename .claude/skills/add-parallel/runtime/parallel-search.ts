import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { query } from '@anthropic-ai/claude-agent-sdk';

type QueryInput = Parameters<typeof query>[0];
type Settings = {
  env?: Record<string, string>;
  permissions?: { deny?: string[] };
  disabledMcpjsonServers?: string[];
};

export const PARALLEL_SEARCH_URL = 'https://search.parallel.ai/mcp';
export const PARALLEL_USER_AGENT = 'NanoClaw/1.2.35 (Parallel Search MCP)';
const SERVER = 'parallel-search';
const BUILTINS = ['WebSearch', 'WebFetch'];
const TOOLS = [`mcp__${SERVER}__web_search`, `mcp__${SERVER}__web_fetch`];
const SEARCH_KEYS = [
  'PARALLEL_API_KEY',
  'BRAVE_API_KEY',
  'TAVILY_API_KEY',
  'EXA_API_KEY',
  'PERPLEXITY_API_KEY',
  'SERPAPI_API_KEY',
];

function readObject(file: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Expected a JSON object in ${file}`);
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error; // Do not erase unreadable or malformed saved configuration.
  }
}

function matches(rule: string, tool: string): boolean {
  // A scoped WebSearch deny is also an intentional search restriction. Do not
  // bypass it by making a different provider available automatically.
  const name = rule.split('(')[0];
  const pattern = name
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${pattern}$`).test(tool);
}

/** Add the native HTTP server only for an installed, unconfigured search path. */
export function withParallelSearch(input: QueryInput): QueryInput {
  const options = input.options ?? {};
  const cwd = options.cwd ?? process.cwd();
  const home = os.homedir();
  const configDir =
    options.env?.CLAUDE_CONFIG_DIR ??
    process.env.CLAUDE_CONFIG_DIR ??
    path.join(home, '.claude');
  const settings = [
    path.join(configDir, 'settings.json'),
    path.join(cwd, '.claude', 'settings.json'),
    path.join(cwd, '.claude', 'settings.local.json'),
  ].map((file) => readObject(file) as Settings);
  const env = Object.assign(
    {},
    ...settings.map((s) => s.env ?? {}),
    options.env ?? process.env,
  );
  const choice = env.NANOCLAW_SEARCH_PROVIDER;
  if (choice && !['parallel', 'builtin', 'disabled'].includes(choice)) {
    throw new Error(
      'NANOCLAW_SEARCH_PROVIDER must be parallel, builtin, or disabled',
    );
  }
  if (choice === 'builtin') return input;

  if (choice === 'disabled') {
    // Do not mutate the caller's configuration or enable a replacement tool.
    const servers = { ...options.mcpServers };
    delete servers[SERVER];
    return {
      ...input,
      options: {
        ...options,
        mcpServers: servers,
        disallowedTools: [
          ...(options.disallowedTools ?? []),
          ...BUILTINS,
          `mcp__${SERVER}__*`,
        ],
      },
    };
  }

  const denies = [
    ...(options.disallowedTools ?? []),
    ...settings.flatMap((s) => s.permissions?.deny ?? []),
  ];
  if (
    denies.some((rule) =>
      [...BUILTINS, ...TOOLS].some((tool) => matches(rule, tool)),
    ) ||
    settings.some((s) => s.disabledMcpjsonServers?.includes(SERVER))
  )
    return input;

  // Respect existing MCP configuration even if its provider name is unfamiliar.
  // The explicit parallel override never overwrites a server with this name.
  if (options.mcpServers?.[SERVER]) return input;
  const userConfigs = [
    readObject(path.join(home, '.claude.json')),
    readObject(path.join(configDir, '.claude.json')),
  ];
  const projectConfigs = userConfigs.map(
    (config) =>
      (
        config.projects as
          | Record<string, Settings & { mcpServers?: object }>
          | undefined
      )?.[cwd],
  );
  if (
    [...userConfigs, ...projectConfigs].some((config) =>
      (config?.disabledMcpjsonServers as string[] | undefined)?.includes(
        SERVER,
      ),
    )
  )
    return input;
  const savedServers = [
    ...userConfigs.map((config) => config.mcpServers),
    ...projectConfigs.map((config) => config?.mcpServers),
    readObject(path.join(cwd, '.mcp.json')).mcpServers,
  ];
  if (
    savedServers.some(
      (s) => s && typeof s === 'object' && Object.keys(s).length,
    )
  )
    return input;
  if (
    !choice &&
    (SEARCH_KEYS.some((key) => env[key]) ||
      Object.keys(options.mcpServers ?? {}).some((name) => name !== 'nanoclaw'))
  )
    return input;

  return {
    ...input,
    options: {
      ...options,
      mcpServers: {
        ...options.mcpServers,
        [SERVER]: {
          type: 'http',
          url: PARALLEL_SEARCH_URL,
          headers: { 'User-Agent': PARALLEL_USER_AGENT },
        },
      },
      allowedTools: [
        ...(options.allowedTools ?? []).filter((t) => !BUILTINS.includes(t)),
        ...TOOLS,
      ],
      disallowedTools: [...(options.disallowedTools ?? []), ...BUILTINS],
    },
  };
}
