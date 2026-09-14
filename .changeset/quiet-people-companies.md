---
"@everyai/cli": patch
---

Fixed retired-tool errors from the 2026-09-09 People/Companies migration. `every invoice create --client`, `every contact list`, and the bundled `use-every` skill's lead-intake example all called MCP tools (`list_clients`, `list_contacts`, `create_contact`) that the server now rejects with "This tool is retired." They now call the live replacements (`list_companies`, `list_people`, `create_person`) with the current `query` search parameter.

- `--client <name>` on `invoice create` still works (deprecated alias); `--company <name>` is the preferred spelling, and a new `--person <name>` resolves via `list_people` for a Person recipient.
- The local write-tier override for the retired `create_client_deal` now targets its live replacement, `create_delivery_deal`.
- Test fixtures now mirror the live 98-tool surface (was pinned to a stale 85-tool snapshot that still listed the nine retired Client/Contact tools and was missing all twelve live People/Companies tools).
