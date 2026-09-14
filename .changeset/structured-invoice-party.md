---
"@everyai/cli": patch
---

Fixed a second, deeper break from the same migration: `create_invoice` no longer accepts a flat `client_id`. The server now requires a structured `command: {operation_id, party: {kind, id}, line_items, ...}` and rejects the old shape with "client_id is retired on this tool." `every invoice create --client/--company/--person` now resolves the recipient's kind (Person or Company) and builds that structured payload, generating a fresh `operation_id` UUID per write that is reused only for the server's own confirmation retry (never minted twice for one logical write). A bare `--client-id` with no `--company`/`--person` alongside it defaults to a Company party, matching this CLI's historical "client" meaning. The test fixture's `create_invoice` schema and mock server now reflect the structured shape, and dedicated tests prove the built payload against that schema so a reintroduced flat `client_id` fails loudly instead of shipping quietly again.
