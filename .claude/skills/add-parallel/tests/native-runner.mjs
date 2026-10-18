/**
 * Native Claude Agent SDK smoke test for an installed /add-parallel runner.
 * Run after installing the skill and building container/agent-runner:
 *   node .claude/skills/add-parallel/tests/native-runner.mjs /path/to/checkout
 * The model is a scripted local Anthropic Messages fixture, not model inference.
 * A local TLS proxy observes the unchanged production URL and User-Agent.
 * --live forwards MCP requests anonymously to Parallel; model inference stays local.
 * Run in a disposable NanoClaw container/workspace: the runner uses /workspace/group
 * and /workspace/ipc/input. No API credentials or saved Claude settings are used.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

assert.equal(
  process.env.NANOCLAW_NATIVE_SMOKE_DISPOSABLE,
  '1',
  'Run only in a disposable NanoClaw workspace; set NANOCLAW_NATIVE_SMOKE_DISPOSABLE=1',
);
const repo = path.resolve(process.argv[2] || '.');
const live = process.argv.includes('--live');
const selected = process.argv
  .find((a) => a.startsWith('--case='))
  ?.split('=')[1];
const cases = selected
  ? [selected]
  : [
      'success',
      'error',
      'timeout',
      'cancel',
      'builtin',
      'disabled',
      'saved-choice',
      'saved-deny',
      'credentials',
    ];
const endpoint = 'https://search.parallel.ai/mcp';
const userAgent = 'NanoClaw/1.2.35 (Parallel Search MCP)';
const runner = path.join(repo, 'container/agent-runner/dist/index.js');
assert(fs.existsSync(runner), 'Build the installed agent runner first');
const scratch = fs.mkdtempSync(
  path.join(os.tmpdir(), 'nanoclaw-parallel-native-'),
);
const listen = (server) =>
  new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(server.address().port)),
  );
const readBody = async (req) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
};
const json = (res, value, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
};
const reports = [];
const debug = (...args) => {
  if (process.env.NATIVE_SMOKE_DEBUG) console.error(...args);
};
const fetchUrl = live
  ? 'https://example.com/'
  : 'https://example.com/?a=1&b=two%20words#section';
const sessionId = 'nanoclaw-scripted-native-smoke-stable-session';
const tools = [
  {
    name: 'web_search',
    description: 'Search the web',
    inputSchema: {
      type: 'object',
      properties: {
        objective: { type: 'string' },
        search_queries: { type: 'array', items: { type: 'string' } },
        session_id: { type: 'string' },
      },
      required: ['objective', 'search_queries'],
    },
  },
  {
    name: 'web_fetch',
    description: 'Fetch a page',
    inputSchema: {
      type: 'object',
      properties: {
        urls: { type: 'array', items: { type: 'string' } },
        objective: { type: 'string' },
        session_id: { type: 'string' },
      },
      required: ['urls'],
    },
  },
];

// Generated only in scratch; the fixture CA is trusted only by the child SDK.
execFileSync(
  'openssl',
  [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    path.join(scratch, 'key.pem'),
    '-out',
    path.join(scratch, 'cert.pem'),
    '-days',
    '1',
    '-subj',
    '/CN=search.parallel.ai',
    '-addext',
    'subjectAltName=DNS:search.parallel.ai',
  ],
  { stdio: 'ignore' },
);
const tlsOptions = {
  key: fs.readFileSync(path.join(scratch, 'key.pem')),
  cert: fs.readFileSync(path.join(scratch, 'cert.pem')),
};

function sendMessage(res, content, stopReason) {
  const id = 'msg_scripted_' + Date.now();
  const message = {
    id,
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 1 },
  };
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    'request-id': id,
  });
  const event = (name, data) =>
    res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  event('message_start', { type: 'message_start', message });
  content.forEach((block, index) => {
    event('content_block_start', {
      type: 'content_block_start',
      index,
      content_block:
        block.type === 'text'
          ? { type: 'text', text: '' }
          : { ...block, input: {} },
    });
    event('content_block_delta', {
      type: 'content_block_delta',
      index,
      delta:
        block.type === 'text'
          ? { type: 'text_delta', text: block.text }
          : {
              type: 'input_json_delta',
              partial_json: JSON.stringify(block.input),
            },
    });
    event('content_block_stop', { type: 'content_block_stop', index });
  });
  event('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 50 },
  });
  event('message_stop', { type: 'message_stop' });
  res.end();
}

async function runCase(mode) {
  assert(
    [
      'success',
      'error',
      'timeout',
      'cancel',
      'builtin',
      'disabled',
      'saved-choice',
      'saved-deny',
      'credentials',
    ].includes(mode),
    `Unknown case ${mode}`,
  );
  if (live) assert.equal(mode, 'success', 'Use --live --case=success');
  const preservesSelection = [
    'builtin',
    'disabled',
    'saved-choice',
    'saved-deny',
    'credentials',
  ].includes(mode);
  const observations = [];
  const modelRequests = [];
  const consumed = [];
  const sockets = new Set();
  let modelTurn = 0;
  let child;
  let cancellationSent = false;
  let liveQuota = false;
  const pendingResponses = [];
  const mcp = https.createServer(tlsOptions, async (req, res) => {
    try {
      debug('HTTP', req.method, req.url);
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const observedUrl = `https://${req.headers.host}${req.url}`;
      const observation = {
        url: observedUrl,
        userAgent: req.headers['user-agent'],
        method: req.method,
        rpc: body.method,
        params: body.params,
        hasAuthorization: !!req.headers.authorization,
      };
      observations.push(observation);
      assert.equal(observedUrl, endpoint);
      assert.equal(req.headers['user-agent'], userAgent);
      assert.equal(observation.hasAuthorization, false);
      if (live) {
        // curl honors the test host's HTTP(S)_PROXY and CA configuration. The
        // native SDK request above still supplies the URL and observed headers.
        const headerFile = path.join(
          scratch,
          `upstream-${observations.length}.headers`,
        );
        const args = [
          '--silent',
          '--show-error',
          '--compressed',
          '--max-time',
          '20',
          '--dump-header',
          headerFile,
          '--request',
          req.method,
        ];
        for (const [key, value] of Object.entries(req.headers)) {
          if (
            ![
              'host',
              'connection',
              'content-length',
              'transfer-encoding',
              'accept-encoding',
            ].includes(key)
          )
            args.push('--header', `${key}: ${value}`);
        }
        args.push('--data-binary', '@-', endpoint);
        const upstream = spawn('curl', args, {
          env: process.env,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let response = '',
          upstreamError = '';
        upstream.stdout.on('data', (c) => (response += c));
        upstream.stderr.on('data', (c) => (upstreamError += c));
        upstream.on('close', (code) => {
          if (res.destroyed) return;
          const rawHeaders = fs.existsSync(headerFile)
            ? fs.readFileSync(headerFile, 'utf8')
            : '';
          const block =
            rawHeaders
              .trim()
              .split(/\r?\n\r?\n/)
              .at(-1) ?? '';
          const lines = block.split(/\r?\n/);
          const status = Number(lines.shift()?.split(' ')[1]) || 502;
          const headers = {};
          for (const line of lines) {
            const colon = line.indexOf(':');
            if (colon > 0)
              headers[line.slice(0, colon).toLowerCase()] = line
                .slice(colon + 1)
                .trim();
          }
          observation.status = status;
          observation.response = response;
          observation.retryAfter = headers['retry-after'] ?? null;
          observation.at = new Date().toISOString();
          if (code !== 0) observation.forwardingError = upstreamError;
          let serviceError = false;
          try {
            const value = JSON.parse(response);
            serviceError = Boolean(value.error || value.result?.isError);
          } catch {
            /* Non-JSON HTTP errors are checked by status. */
          }
          if (
            status === 429 ||
            (serviceError &&
              /quota|rate.limit|too many requests/i.test(response))
          )
            liveQuota = true;
          delete headers['content-encoding'];
          delete headers['transfer-encoding'];
          delete headers.connection;
          delete headers['content-length'];
          res.writeHead(status, headers);
          res.end(response);
        });
        res.on('close', () => upstream.kill('SIGTERM'));
        upstream.stdin.end(raw);
        return;
      }
      if (req.method === 'GET' || req.method === 'DELETE') {
        res.writeHead(405);
        res.end();
        return;
      }
      if (!('id' in body)) {
        res.writeHead(202);
        res.end();
        return;
      }
      res.setHeader('mcp-session-id', 'native-fixture-session');
      let result;
      if (body.method === 'initialize')
        result = {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'scripted-native-fixture', version: '1.0.0' },
        };
      else if (body.method === 'tools/list') result = { tools };
      else if (body.method === 'tools/call') {
        if (mode === 'timeout' || mode === 'cancel') {
          pendingResponses.push(res);
          if (mode === 'cancel' && !cancellationSent) {
            cancellationSent = true;
            setTimeout(() => child.kill('SIGUSR1'), 100);
          }
          return;
        }
        result =
          mode === 'error'
            ? {
                isError: true,
                content: [
                  {
                    type: 'text',
                    text: 'SCRIPTED_UPSTREAM_ERROR: service unavailable',
                  },
                ],
              }
            : {
                content: [
                  {
                    type: 'text',
                    text:
                      body.params.name === 'web_search'
                        ? 'SCRIPTED_SEARCH_RESULT: IANA reserves example.com for documentation. Source: https://example.com/'
                        : 'SCRIPTED_FETCH_RESULT: Example Domain is for documentation examples.',
                  },
                ],
              };
      } else result = {};
      json(res, { jsonrpc: '2.0', id: body.id, result });
    } catch (error) {
      observations.push({ fixtureError: error.message });
      json(res, { error: error.message }, 500);
    }
  });
  mcp.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  mcp.on('tlsClientError', (error) => debug('TLS', error.message));
  const mcpPort = await listen(mcp);
  const proxy = http.createServer((_req, res) => {
    res.writeHead(502);
    res.end();
  });
  proxy.on('connect', (req, client, head) => {
    debug('CONNECT', req.url);
    // The native SDK connects to the production host, while this test alone
    // terminates TLS locally. No product endpoint override is introduced.
    if (req.url !== 'search.parallel.ai:443') {
      client.destroy();
      return;
    }
    const target = net.connect(mcpPort, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) target.write(head);
      client.pipe(target);
      target.pipe(client);
    });
    target.on('error', () => client.destroy());
    client.on('error', () => target.destroy());
    sockets.add(client);
    sockets.add(target);
    client.on('close', () => sockets.delete(client));
    target.on('close', () => sockets.delete(target));
  });
  const proxyPort = await listen(proxy);
  const model = http.createServer(async (req, res) => {
    try {
      debug('HTTP', req.method, req.url);
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      if (req.url.includes('count_tokens'))
        return json(res, { input_tokens: 100 });
      if (!req.url.includes('/messages')) return json(res, {});
      const names = (body.tools || []).map((t) => t.name);
      modelRequests.push({ path: req.url, toolNames: names, turn: modelTurn });
      for (const message of body.messages || [])
        for (const block of Array.isArray(message.content)
          ? message.content
          : []) {
          if (
            block.type === 'tool_result' &&
            !consumed.some((c) => c.tool_use_id === block.tool_use_id)
          )
            consumed.push(block);
        }
      const searchName = names.find((n) => n.endsWith('__web_search'));
      const fetchName = names.find((n) => n.endsWith('__web_fetch'));
      if (preservesSelection) {
        assert(
          !searchName && !fetchName,
          'Explicit, saved, credential or denied configuration must not enable Parallel',
        );
        if (mode === 'disabled')
          assert(
            !names.includes('WebSearch') && !names.includes('WebFetch'),
            'Disabled search must disable native builtins',
          );
        if (mode === 'saved-deny')
          assert(
            !names.includes('WebSearch'),
            'Saved permissions must remain effective',
          );
        if (['builtin', 'saved-choice', 'credentials'].includes(mode))
          assert(
            names.includes('WebSearch') && names.includes('WebFetch'),
            'Existing builtin tools must remain available',
          );
        sendMessage(
          res,
          [{ type: 'text', text: 'SCRIPTED_SELECTION_VERIFIED: ' + mode }],
          'end_turn',
        );
        setTimeout(
          () => fs.writeFileSync('/workspace/ipc/input/_close', ''),
          200,
        );
        return;
      }
      assert(
        searchName && fetchName,
        'Native SDK model request must contain discovered Parallel search/fetch tools',
      );
      assert(
        !names.includes('WebSearch') && !names.includes('WebFetch'),
        'Unconfigured Parallel must replace builtin search/fetch',
      );
      if (modelTurn++ === 0)
        sendMessage(
          res,
          [
            {
              type: 'tool_use',
              id: 'call_search',
              name: searchName,
              input: {
                objective: 'Verify the documented purpose of example.com',
                search_queries: ['IANA example.com documentation domain'],
                session_id: sessionId,
              },
            },
          ],
          'tool_use',
        );
      else if (mode === 'success' && !liveQuota && consumed.length === 1)
        sendMessage(
          res,
          [
            {
              type: 'tool_use',
              id: 'call_fetch',
              name: fetchName,
              input: {
                urls: [fetchUrl],
                objective: 'Read the exact page title and purpose',
                session_id: sessionId,
              },
            },
          ],
          'tool_use',
        );
      else {
        const text = `SCRIPTED_MODEL_CONSUMED: ${consumed.map((b) => (typeof b.content === 'string' ? b.content : JSON.stringify(b.content))).join(' | ')}`;
        sendMessage(res, [{ type: 'text', text }], 'end_turn');
        if (mode !== 'cancel')
          setTimeout(
            () => fs.writeFileSync('/workspace/ipc/input/_close', ''),
            200,
          );
      }
    } catch (error) {
      modelRequests.push({ fixtureError: error.message });
      json(res, { error: { type: 'api_error', message: error.message } }, 500);
    }
  });
  const modelPort = await listen(model);
  const home = path.join(scratch, mode, 'home');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  if (mode === 'saved-choice')
    fs.writeFileSync(
      path.join(home, '.claude/settings.json'),
      JSON.stringify({ env: { NANOCLAW_SEARCH_PROVIDER: 'builtin' } }),
    );
  if (mode === 'saved-deny')
    fs.writeFileSync(
      path.join(home, '.claude/settings.json'),
      JSON.stringify({ permissions: { deny: ['WebSearch'] } }),
    );
  fs.mkdirSync('/workspace/group', { recursive: true });
  fs.mkdirSync('/workspace/ipc/input', { recursive: true });
  const sdkEnv = {
    PATH: process.env.PATH,
    HOME: home,
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    ANTHROPIC_API_KEY: 'scripted-fixture-no-real-credential',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${modelPort}`,
    HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
    HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
    NO_PROXY: '127.0.0.1,localhost',
    NODE_EXTRA_CA_CERTS: path.join(scratch, 'cert.pem'),
    IS_SANDBOX: '1',
    ENABLE_TOOL_SEARCH: 'false',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    MCP_TOOL_TIMEOUT: mode === 'timeout' ? '1000' : '20000',
    MCP_TIMEOUT: '10000',
  };
  if (mode === 'builtin' || mode === 'disabled')
    sdkEnv.NANOCLAW_SEARCH_PROVIDER = mode;
  if (mode === 'credentials')
    sdkEnv.BRAVE_API_KEY = 'scripted-existing-search-credential';
  let stdout = '',
    stderr = '';
  let childArgs = [runner];
  if (mode === 'cancel') {
    const worker = path.join(scratch, 'cancel-worker.mjs');
    fs.writeFileSync(
      worker,
      `import {query} from ${JSON.stringify('file://' + path.join(repo, 'container/agent-runner/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs'))};\nimport {withParallelSearch} from ${JSON.stringify('file://' + path.join(repo, 'container/agent-runner/dist/parallel-search.js'))};\nconst abortController=new AbortController(); process.on('SIGUSR1',()=>abortController.abort());\ntry { for await(const message of query(withParallelSearch({prompt:'Run the search tool.',options:{cwd:'/workspace/group',env:process.env,abortController,permissionMode:'bypassPermissions',allowDangerouslySkipPermissions:true,settingSources:[]}}))) { console.log(JSON.stringify(message)); } console.log('NATIVE_CANCEL_COMPLETED'); } catch(e) { if(!abortController.signal.aborted)throw e;console.log('NATIVE_CANCEL_COMPLETED '+e.name); }\n`,
    );
    childArgs = [worker];
  }
  child = spawn(process.execPath, childArgs, {
    cwd: repo,
    env: sdkEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (data) => (stdout += data));
  child.stderr.on('data', (data) => {
    stderr += data;
    debug(String(data));
  });
  child.stdin.end(
    JSON.stringify({
      prompt:
        'Use Parallel search and fetch to verify the purpose of example.com.',
      groupFolder: 'native-test',
      chatJid: 'fixture',
      isMain: true,
    }),
  );
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, 60000);
  const exit = await new Promise((resolve) =>
    child.on('close', (code, signal) => resolve({ code, signal })),
  );
  clearTimeout(timer);
  for (const res of pendingResponses) res.destroy();
  for (const socket of sockets) socket.destroy();
  await Promise.all([
    new Promise((r) => model.close(r)),
    new Promise((r) => mcp.close(r)),
    new Promise((r) => proxy.close(r)),
  ]);
  const report = {
    case: mode,
    live,
    model: 'scripted Anthropic Messages fixture; no model inference',
    at: new Date().toISOString(),
    exit,
    timedOut,
    observations,
    modelRequests,
    consumed,
    stdout,
    stderr,
  };
  reports.push(report);
  if (process.env.NATIVE_SMOKE_REPORT)
    fs.writeFileSync(
      process.env.NATIVE_SMOKE_REPORT,
      JSON.stringify(reports, null, 2) + '\n',
    );
  assert(
    !timedOut,
    `Native ${mode} smoke exceeded its deadline: ${stderr.slice(-2000)}`,
  );
  assert.equal(
    exit.code,
    0,
    `Native ${mode} child failed: ${stderr.slice(-2000)}`,
  );
  if (preservesSelection) {
    assert.equal(
      observations.length,
      0,
      'Preserved selection must not contact Parallel',
    );
    assert(
      !modelRequests.some((o) => o.fixtureError),
      'Native SDK must preserve provider/permissions in its model tools',
    );
    assert(
      stdout.includes('SCRIPTED_SELECTION_VERIFIED'),
      'Installed runner must publish selection validation result',
    );
    console.log(
      JSON.stringify({
        case: mode,
        status: 'passed',
        mcpRequests: 0,
        modelFixture: true,
      }),
    );
    return;
  }
  assert(
    observations.some((o) => o.rpc === 'tools/list'),
    'Native SDK must discover MCP tools',
  );
  assert(
    observations.some((o) => o.rpc === 'tools/call'),
    'Native SDK must dispatch an MCP tool',
  );
  assert(
    !observations.some((o) => o.fixtureError),
    'MCP request URL and User-Agent must match',
  );
  assert(
    !modelRequests.some((o) => o.fixtureError),
    'Model fixture must receive discovered tools',
  );
  if (mode === 'cancel')
    assert(
      stdout.includes('NATIVE_CANCEL_COMPLETED') && cancellationSent,
      'Native SDK cancellation must finish',
    );
  else {
    assert(
      stdout.includes('SCRIPTED_MODEL_CONSUMED'),
      'Installed runner must publish the model result',
    );
    assert(
      consumed.length > 0,
      'Native SDK must pass tool_result back to the model',
    );
    if (mode === 'success' && !liveQuota) {
      assert(
        consumed.every((result) => !result.is_error),
        'Successful search and fetch must not return tool errors',
      );
      assert(
        consumed.length >= 2,
        'Search and fetch results must both reach the model',
      );
    }
    if (!live && mode === 'success')
      assert.deepEqual(
        observations.find(
          (o) => o.rpc === 'tools/call' && o.params.name === 'web_fetch',
        )?.params.arguments.urls,
        [fetchUrl],
        'Fetch URLs must retain queries, escaping and fragments',
      );
    if (!live && mode === 'success')
      assert(
        stdout.includes('SCRIPTED_SEARCH_RESULT') &&
          stdout.includes('SCRIPTED_FETCH_RESULT'),
        'Model result must consume search and fetch output',
      );
    if (mode === 'error')
      assert(
        stdout.includes('SCRIPTED_UPSTREAM_ERROR'),
        'Upstream error must reach model result',
      );
    if (mode === 'timeout')
      assert(
        /timeout|timed out/i.test(JSON.stringify(consumed)),
        'Native SDK timeout must reach model as error',
      );
  }
  console.log(
    JSON.stringify({
      case: mode,
      status: liveQuota ? 'anonymous_quota_observed' : 'passed',
      mcpRequests: observations.length,
      toolResults: consumed.length,
      modelFixture: true,
    }),
  );
}
try {
  for (const mode of cases) await runCase(mode);
} finally {
  fs.rmSync(scratch, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  });
}
