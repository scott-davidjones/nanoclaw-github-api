# Integration tests

The installer and resolver tests do not need model inference or network access:

```sh
node --experimental-strip-types --test .claude/skills/add-parallel/tests/*.test.mjs
```

The native smoke harness exercises the installed runner through the real Claude
Agent SDK. It uses a **scripted local Anthropic Messages fixture**, so it does not
measure model quality or require Anthropic credentials. A local TLS proxy observes
the actual native HTTP MCP requests, including the unchanged production URL and
project User-Agent. In its default mode, the proxy serves deterministic MCP tools.

Run it only in a disposable NanoClaw development container/workspace with Node 22
and OpenSSL. The runner uses absolute `/workspace/group` and
`/workspace/ipc/input` paths; the test creates directories and writes the `_close`
sentinel there. Keep real NanoClaw sessions out of that workspace. Its isolated
HOME contains no saved credentials, and child environment variables are allowlisted.
The explicit environment variable below acknowledges those filesystem effects.

From a fresh checkout, install the runtime and its existing runner dependencies:

```sh
node .claude/skills/add-parallel/scripts/install.mjs .
npm --prefix container/agent-runner ci --ignore-scripts
npm --prefix container/agent-runner run build
NANOCLAW_NATIVE_SMOKE_DISPOSABLE=1 \
  node .claude/skills/add-parallel/tests/native-runner.mjs .
```

The success case launches the installed `dist/index.js`, discovers MCP tools,
dispatches search and fetch selected by the scripted model, passes both tool
results back to that model fixture, and checks NanoClaw's published result. It
also checks exact fetch URL propagation and that native WebSearch/WebFetch are
unavailable when unconfigured Parallel is selected. Additional native cases check
upstream tool errors, SDK timeouts, explicit builtin and disabled choices, a saved
choice, saved deny permissions, and an existing search credential. The cancellation
case invokes the same installed resolver through the real SDK with an
AbortController, while a tool call is pending. It does not launch NanoClaw's main
IPC loop for that case.

For an optional anonymous live smoke, install `curl` as well. The proxy forwards
observed native requests to Parallel and honors the host's proxy/CA configuration;
model inference remains scripted and local:

```sh
NANOCLAW_NATIVE_SMOKE_DISPOSABLE=1 \
  node .claude/skills/add-parallel/tests/native-runner.mjs . --live --case=success
```

Live requests consume the free service's quota. A live quota response is reported
as `anonymous_quota_observed`, not a successful live search. The deterministic
cases still need to pass. Honor any Retry-After before another live attempt; do
not change session identities or add credentials to work around limits. Other
connection, authentication and parsing failures remain failures.

Set `NATIVE_SMOKE_REPORT` to a path outside the checkout to retain detailed private
request/result evidence, or `NATIVE_SMOKE_DEBUG=1` for fixture diagnostics. Reports
contain service responses and may contain supplied test query text; do not commit
them. This validates the installed runner directly; it does not build a Docker
image or test a running chat service.
