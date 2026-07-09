# @everyai/cli

The **agent-agnostic** command line for [Every AI](https://every.ai) — manage your business (invoices, clients, contacts, proposals, deals) from any shell, any coding agent, or CI.

Install once, log in once, and the same `every` command works everywhere your agents run — Claude Code, Codex, Cursor, plain terminals, cron, CI — instead of wiring a bespoke MCP + OAuth setup into each host.

```bash
npm install -g @everyai/cli
every login            # opens your browser (OAuth + PKCE); tokens land in your OS keychain
every whoami --json    # authenticated check: who you are + how many tools you have
every tools list       # the full tool surface, with safety classifications
```

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
every tools list [--no-cache]
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
{ "ok": true,  "data": { /* ... */ }, "schema_version": 1 }
{ "ok": false, "error": { "message": "...", "code": "..." }, "schema_version": 1 }
```

Exit codes: `0` ok · `1` tool/generic error · `2` usage · `3` auth (run `every login`) · `4` permission/confirmation needed · `5` rate-limited · `6` not found · `7` network/timeout.

## Headless / CI

Set `EVERY_TOKEN` to a valid access token to skip the browser flow entirely. `login` requires a TTY by design and fails fast (exit `3`) without one.

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
