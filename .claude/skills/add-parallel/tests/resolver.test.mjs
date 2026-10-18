import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  withParallelSearch,
  PARALLEL_SEARCH_URL,
  PARALLEL_USER_AGENT,
} from '../runtime/parallel-search.ts';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-search-'));
  const previous = process.env.HOME;
  process.env.HOME = path.join(root, 'home');
  fs.mkdirSync(process.env.HOME);
  t.after(() => {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const input = {
    prompt: 'Find current documentation',
    options: {
      cwd: path.join(root, 'group'),
      env: {},
      allowedTools: ['Read', 'WebSearch', 'WebFetch', 'mcp__nanoclaw__*'],
      mcpServers: { nanoclaw: { command: 'node', args: ['ipc.js'] } },
    },
  };
  const save = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  };
  return { input, save, home: process.env.HOME, cwd: input.options.cwd };
}

test('fresh no-key path uses native anonymous HTTP and preserves unrelated options', (t) => {
  const { input } = fixture(t);
  const abortController = new AbortController();
  input.options.abortController = abortController;
  const result = withParallelSearch(input);
  assert.deepEqual(result.options.mcpServers['parallel-search'], {
    type: 'http',
    url: 'https://search.parallel.ai/mcp',
    headers: { 'User-Agent': 'NanoClaw/1.2.35 (Parallel Search MCP)' },
  });
  assert.equal(
    PARALLEL_SEARCH_URL,
    result.options.mcpServers['parallel-search'].url,
  );
  assert.equal(
    PARALLEL_USER_AGENT,
    result.options.mcpServers['parallel-search'].headers['User-Agent'],
  );
  assert.deepEqual(result.options.disallowedTools, ['WebSearch', 'WebFetch']);
  assert.ok(
    result.options.allowedTools.includes('mcp__parallel-search__web_search'),
  );
  assert.equal(result.options.abortController, abortController);
  assert.equal(input.options.mcpServers['parallel-search'], undefined);
});

test('saved builtin choice and explicit override have predictable precedence', (t) => {
  const { input, save, home } = fixture(t);
  save(path.join(home, '.claude/settings.json'), {
    env: { NANOCLAW_SEARCH_PROVIDER: 'builtin' },
  });
  assert.equal(withParallelSearch(input), input);
  input.options.env.NANOCLAW_SEARCH_PROVIDER = 'parallel';
  assert.ok(withParallelSearch(input).options.mcpServers['parallel-search']);
});

test('disabled choice disables owned tools and preserves separately configured Task', (t) => {
  const { input } = fixture(t);
  input.options.env.NANOCLAW_SEARCH_PROVIDER = 'disabled';
  input.options.mcpServers['parallel-task'] = {
    type: 'http',
    url: 'https://task.example/mcp',
  };
  input.options.mcpServers['parallel-search'] = {
    type: 'http',
    url: 'https://saved.example/mcp',
  };
  const result = withParallelSearch(input);
  assert.equal(result.options.mcpServers['parallel-search'], undefined);
  assert.equal(
    result.options.mcpServers['parallel-task'],
    input.options.mcpServers['parallel-task'],
  );
  assert.ok(result.options.disallowedTools.includes('mcp__parallel-search__*'));
  assert.ok(input.options.mcpServers['parallel-search']);
});

test('saved permissions and disabled MCP server cannot be bypassed by provider override', (t) => {
  const { input, save, cwd } = fixture(t);
  input.options.env.NANOCLAW_SEARCH_PROVIDER = 'parallel';
  for (const rule of [
    'WebSearch',
    'WebSearch(domain:example.com)',
    'mcp__*',
    'mcp__parallel-search__*',
  ]) {
    save(path.join(cwd, '.claude/settings.local.json'), {
      permissions: { deny: [rule] },
    });
    assert.equal(withParallelSearch(input), input, rule);
  }
  save(path.join(cwd, '.claude/settings.local.json'), {
    disabledMcpjsonServers: ['parallel-search'],
  });
  assert.equal(withParallelSearch(input), input);
});

test('saved MCP choices, named servers and credentials keep their original behavior', (t) => {
  const { input, save, cwd, home } = fixture(t);
  input.options.env.PARALLEL_API_KEY = 'fixture-configured-key';
  assert.equal(withParallelSearch(input), input);
  delete input.options.env.PARALLEL_API_KEY;
  input.options.mcpServers.custom = {
    type: 'http',
    url: 'https://custom.example/mcp',
  };
  assert.equal(withParallelSearch(input), input);
  delete input.options.mcpServers.custom;
  for (const [file, value] of [
    [
      path.join(cwd, '.mcp.json'),
      { mcpServers: { saved: { command: 'saved' } } },
    ],
    [
      path.join(home, '.claude.json'),
      { projects: { [cwd]: { mcpServers: { saved: { command: 'saved' } } } } },
    ],
  ]) {
    save(file, value);
    assert.equal(withParallelSearch(input), input);
    fs.unlinkSync(file);
  }
});

test('explicit parallel coexists with another server but never overwrites its own name', (t) => {
  const { input } = fixture(t);
  input.options.env.NANOCLAW_SEARCH_PROVIDER = 'parallel';
  input.options.mcpServers.task = {
    type: 'http',
    url: 'https://task.example/mcp',
  };
  assert.equal(
    withParallelSearch(input).options.mcpServers.task,
    input.options.mcpServers.task,
  );
  input.options.mcpServers['parallel-search'] = {
    type: 'http',
    url: 'https://saved.example/mcp',
  };
  assert.equal(withParallelSearch(input), input);
});

test('invalid choices and unreadable saved configuration fail closed', (t) => {
  const { input, save, cwd } = fixture(t);
  input.options.env.NANOCLAW_SEARCH_PROVIDER = 'typo';
  assert.throws(
    () => withParallelSearch(input),
    /must be parallel, builtin, or disabled/,
  );
  delete input.options.env.NANOCLAW_SEARCH_PROVIDER;
  const file = path.join(cwd, '.claude/settings.json');
  save(file, {});
  fs.writeFileSync(file, '{malformed');
  assert.throws(() => withParallelSearch(input), SyntaxError);
});

test('custom Claude config directory and saved per-project disable are respected', (t) => {
  const { input, save, home, cwd } = fixture(t);
  const config = path.join(home, 'custom-config');
  input.options.env.CLAUDE_CONFIG_DIR = config;
  save(path.join(config, 'settings.json'), {
    env: { NANOCLAW_SEARCH_PROVIDER: 'builtin' },
  });
  assert.equal(withParallelSearch(input), input);
  save(path.join(config, 'settings.json'), {});
  save(path.join(config, '.claude.json'), {
    projects: { [cwd]: { disabledMcpjsonServers: ['parallel-search'] } },
  });
  input.options.env.NANOCLAW_SEARCH_PROVIDER = 'parallel';
  assert.equal(withParallelSearch(input), input);
});
