---
"@everyai/cli": minor
---

Pipeline stages are now per workspace. Every workspace starts with Lead, Opportunity, Won and Lost, and an admin can add, rename, reorder or retire the stages between Lead and Won/Lost in the Every app, so the CLI no longer hard-codes the four defaults.

- `every deal move <deal_id> <stage>` and `every deal list --stage <stage>` drop the client-side `lead|opportunity|won|lost` check. The value (a stage key or a label such as `"Proposal sent"`, case-insensitive; legacy names like `closed_won` still resolve) goes to the server unchanged.
- New `every deal stages` lists the workspace's stages in order from `get_pipeline_settings`: label, key, role (`lead`, `middle`, `won`, `lost`) and a one-line criteria summary. `--json` adds a normalized `stages` array next to the raw tool result.
- An unknown or retired stage now reads `Unknown stage "<input>". Available stages: Lead, Discovery booked, ...`, built from the server's `stage_not_found` refusal. `error.code` is `stage_not_found` and `error.tool_error.available_stages` carries the full list for scripts. Exit code stays `1`.
- The bundled `use-every` skill documents stage discovery and the key-or-label rule.

Against a server that predates customizable stages, `deal move` and `deal list --stage` with one of the four defaults behave as before; any other value is rejected by the server's schema instead of locally, and `every deal stages` falls back to the four default stages from the older settings map.
