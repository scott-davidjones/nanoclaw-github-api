# Task and existing integrations

Anonymous Search MCP provides web search and page fetching. It does not replace
[Parallel Task MCP](https://docs.parallel.ai/integrations/mcp/task-mcp), which
supports longer research tasks and requires separate authentication and billing.

An existing Search or Task MCP setup is an explicit user choice. The installer
stops if it finds customized query options, including the authenticated servers
installed by the older `/add-parallel` instructions. Keep that setup rather than
rewriting it automatically. Do not remove its credentials or change a Task run's
polling or scheduling behavior.

For a new authenticated Task installation, follow the current Task MCP guide and
NanoClaw's OneCLI credential-proxy model. Configure it separately and obtain the
user's permission before starting paid research. The anonymous Search installer
never installs a Task server or sends a Parallel credential.

When Task or another server is already present in native runtime options, the
Search resolver conservatively preserves that configuration. Explicitly choose
`parallel` only if the user wants anonymous Search alongside those servers. Use
`builtin` to retain the original search tools and their supported features.
