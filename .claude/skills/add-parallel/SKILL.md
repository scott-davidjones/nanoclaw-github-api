---
name: add-parallel
description: Install free web search and page fetching in NanoClaw's container agent using anonymous Parallel Search MCP. No Parallel account or API key required.
---

# Add Parallel Search

Install [Parallel Search MCP](https://docs.parallel.ai/integrations/mcp/search-mcp)
through the runner's native HTTP MCP transport. Search uses Fast mode. Search and
page fetching need no Parallel account or API key. Free usage has limits.

This utility ships its installer and runtime files beside this guide. Merely
merging this repository to install GitHub API access does not enable web search.
Run this skill explicitly to install it.

## 1. Check the installation

Read the user's current runner and saved Claude settings before making changes.
Keep intentionally configured providers, credentials, permissions and disabled
search. Do not collect a Parallel key or change OneCLI secrets for anonymous
Search. Existing authenticated Search and Task MCP installations remain separate;
see [Task and existing integrations](references/task-mcp.md).

Wait for running agent sessions to finish before installing or removing the
integration. New sessions compile the installed runner source automatically.

Run `node "${CLAUDE_SKILL_DIR}/scripts/install.mjs" . --check` from the NanoClaw
repository root. The installer checks the root runner and all existing per-group
runner caches before writing anything. It supports the runner shipped with this
repository. If query options have been customized or upgraded, it stops without
changing files. Explain the conflict and keep the existing installation; do not
replace its query options to force the installer through.

## 2. Install the executable integration

Run `node "${CLAUDE_SKILL_DIR}/scripts/install.mjs" .`.

This copies the HTTP MCP resolver into the runner, wraps its existing SDK query,
and installs a container skill explaining search, fetching and citations. It also
updates compatible group caches, preserving changes outside the query function.
It adds no dependencies. Repeating the command is safe. The installer refuses to
overwrite customized installed payloads.

Validate with `npm --prefix container/agent-runner ci --ignore-scripts` and
`npm --prefix container/agent-runner run build`. The existing agent image already
contains the SDK and TypeScript compiler; source is compiled when a container
starts, so this integration does not need a new image or host credential changes.
Start a new NanoClaw agent session after installation.

## 3. Select search behavior

For an installed, unconfigured runner, Parallel is the default search/fetch path.
The SDK's built-in `WebSearch` and `WebFetch` are unavailable in that mode. Errors
are returned to the agent without silently switching providers.

The resolver preserves existing MCP configuration and known search-provider
credentials. It conservatively keeps the existing path if any external MCP
server is configured. It also respects saved Claude permission denials and a
saved disabled `parallel-search` MCP server. This may require an explicit choice
when another integration is already present.

Use `NANOCLAW_SEARCH_PROVIDER` in the group's existing Claude settings `env`
object (`data/sessions/<group>/.claude/settings.json`), or in the runner's
environment. Merge this single setting with existing settings; preserve all other
keys. Values are:

- `parallel`: explicitly choose anonymous Parallel, alongside other runtime MCP
  servers. Existing saved MCP files and a server already named `parallel-search`
  remain authoritative. Permission denials still apply.
- `builtin`: retain the original SDK search/fetch behavior, including features
  that Parallel does not provide.
- `disabled`: disable the built-in search/fetch tools and this integration's
  search/fetch tools. Separately configured providers keep their own controls.

Precedence is runner environment, project local settings, project settings, then
user settings. An invalid value or malformed saved settings file stops resolution
instead of discarding the user's configuration.

## 4. Verify with the user

Ask the assistant a current factual question, then ask it to read a specific
public URL. Check that it uses `mcp__parallel-search__web_search` and
`mcp__parallel-search__web_fetch`, returns useful excerpts, and cites source URLs.
Never describe a service error as a successful search. Check that existing GitHub
API access and the selected provider/disable controls still behave as intended.

For automated checks, run
`node --experimental-strip-types --test "${CLAUDE_SKILL_DIR}/tests/install.test.mjs" "${CLAUDE_SKILL_DIR}/tests/resolver.test.mjs"`
on Node 22. These test installation and selection. The separate native-runner
harness exercises the installed SDK caller with a scripted model; see
[validation](tests/README.md).

## Remove

Wait for active sessions to finish, then run
`node "${CLAUDE_SKILL_DIR}/scripts/install.mjs" . --remove --check`, followed by
the same command without `--check`. The installer removes only its own unchanged
payload and query wrapper from the root and compatible group caches. Customized
payloads stop removal for manual review. Start a new agent session afterward.
Saved settings, other MCP integrations and OneCLI credentials are retained.
