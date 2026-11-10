---
"@everyai/cli": patch
---

When admin-mcp refuses a request with a reason, the CLI now shows that reason. Before, it showed only `MCP <method> failed for <url>: HTTP <status>`. For example, a sign-in that did not select a workspace now prints "This sign-in did not select a workspace. Sign in again and pick one (Every CLI: every org switch). (HTTP 403)". With `--json`, the error also has `http_status` and `server_error` (for example `workspace_not_selected`, `workspace_access_removed` or `org_binding_unavailable`). The exit code and `error.code` do not change. A response without a reason keeps the old message.
