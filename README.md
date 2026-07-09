# @everyai/cli

The **agent-agnostic** command line for [Every AI](https://every.ai) — manage invoices, clients, contacts, proposals, deals, and pipeline work from any shell, coding agent, or CI job.

Install once, log in once, and teach each coding agent the same `every` command instead of wiring MCP + OAuth separately into every host.

```bash
npm install -g @everyai/cli
every docs                         # offline command tree, output contract, workflows
every login                        # opens your browser; tokens land in your OS keychain
every skills install claude|codex  # teach Claude Code or Codex how to use Every
every whoami                       # user, org, environment, tool-count check
```

One-shot invoice example with inline args:

```bash
every invoice list --status overdue --json
every tool call create_invoice \
  --arg client_id=client_123 \
  --arg line_items='[{"description":"Strategy work","quantity":1,"unit_price":1500}]' \
  --yes \
  --json
```

## Install as an agent plugin

The npm install remains the primary path. Agent plugins distribute the bundled `use-every` skill, which teaches the agent how to install and use the CLI.

In Claude Code:

```text
/plugin marketplace add Every-AI-Inc/everyai-cli
/plugin install every@everyai-cli
```

Codex's repo-scoped marketplace location is `.agents/plugins/marketplace.json`.

## Why a CLI (vs. adding the MCP server to each host)

The CLI talks to the same Every MCP server (`admin-mcp.every.ai`) and inherits its full tool surface automatically — new tools appear with no CLI upgrade. What the CLI adds:

- **Portability** — one install + one login covers every agent and machine context; remote-MCP config is per-host, per-format, and often impossible in CI.
- **Safety gates** — reads run freely; writes require `--yes`; destructive actions (sends, deletes, voids, payments) additionally require `--allow-destructive`; `--read-only` (or `EVERY_READ_ONLY=1`) locks everything else out. Classifications are enforced locally — including for tools whose server annotations are too optimistic.
- **Deterministic output** — a stable `--json` envelope and exit-code taxonomy an agent can parse and branch on.

## Commands

```bash
# Auth
every login [--staging]        # browser OAuth; keychain storage; refresh handled
every logout | whoami | auth status | org

# Discovery
every docs
every tools list [--filter <substr>] [--no-cache]
every tools describe <name>
every policy explain <name>    # classification + exactly what running it requires

# Run any tool
every tool call <name> [--args file.json|-] [--arg k=v ...] [--yes] [--allow-destructive] [--read-only]

# Curated aliases (same gates, nicer flags)
every invoice list [--status <s>] [--search <q>] [--limit <n>]
every invoice send <invoice_id>            # destructive: needs --yes --allow-destructive
every deal list [--stage <s>] [--search <q>]
every deal move <deal_id> <stage>          # write: needs --yes
every contact list [--search <q>]

# Teach your coding agent to use all of this well
every skills install claude    # → .claude/skills/use-every/
every skills install codex     # → .agents/skills/use-every/
```

## Output contract

Every command supports `--json`: exactly one JSON document on stdout, nothing else.

```jsonc
{ "ok": true,  "data": { /* ... */ }, "env": "production", "schema_version": 1 }
{ "ok": false, "error": { "message": "...", "code": "..." }, "env": "production", "schema_version": 1 }
```

Exit codes: `0` ok · `1` tool/generic error · `2` usage · `3` auth (run `every login`) · `4` permission/confirmation needed · `5` rate-limited · `6` not found · `7` network/timeout.

## Headless / CI

Set `EVERY_TOKEN` to a valid access token to skip the browser flow entirely. `login` requires a TTY by design and fails fast (exit `3`) without one.

Target precedence: `--staging` > `EVERY_MCP_URL` > `EVERY_ENV=staging|production` > production.

## Status

Pre-release. Built against Every's production MCP surface; `--staging` targets Every's internal staging environment.

## Development

```bash
npm install
npm run dev -- ping --staging --json   # run from source
npm run typecheck
npm test
npm run build
```
