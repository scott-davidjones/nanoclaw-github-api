---
name: parallel-search
description: Search the web for current facts and research, or fetch a specific public web page, using Parallel Search MCP.
allowed-tools: mcp__parallel-search__web_search, mcp__parallel-search__web_fetch
---

Use `mcp__parallel-search__web_search` for web research. Supply an objective and
related search queries. Answer from the returned excerpts and cite their URLs.
Use `mcp__parallel-search__web_fetch` when the user supplies a URL, needs exact
wording, or search excerpts are insufficient. Preserve query strings in URLs.

Search uses Parallel Fast mode. Search and fetching need no Parallel account or
API key. Free usage has limits: report service errors honestly. Do not switch to
another provider automatically after an error. Deep research via Parallel Task
MCP is separate and may require credentials and payment; this skill does not
configure it.

Respect the user's configured provider, tool permissions and disabled search.
If these tools are unavailable, do not claim to have searched or fetched a page.
