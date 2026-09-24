---
"@everyai/cli": patch
---

Tool refusals now carry the server's stable error code. When a tool call fails and the Every server attaches a structured error (`structuredContent.error`), `error.code` in the `--json` envelope is that code (e.g. `duplicate_deal`, `party_unresolved`, `contact_suppressed`) and `error.tool_error` holds the server's full error object (e.g. `existing_deal_id`). Exit code stays `1`. Servers that send no structured error keep producing `error.code: "generic"`, so this is backward compatible. README and the bundled `use-every` skill document branching on the code.
