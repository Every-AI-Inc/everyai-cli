# @everyai/cli

The recommended, **agent-agnostic** command-line surface for [Every AI](https://every.ai).

Install it once and authenticate once (`every login`), and the same `every` command
works everywhere your agents run — Claude Code, Codex, Cursor, or plain CI — instead of
wiring a bespoke MCP/auth setup into each host.

```bash
npm install -g @everyai/cli
every login        # (coming in a later phase)
every ping         # unauthenticated connectivity check
```

## Output contract

Every command supports a stable, machine-readable envelope via `--json`:

```jsonc
// success
{ "ok": true,  "data": { /* ... */ }, "schema_version": 1 }
// failure
{ "ok": false, "error": { "message": "...", "code": "..." }, "schema_version": 1 }
```

`--staging` targets the staging MCP server. Exit codes are stable and documented in
`src/lib/exit-codes.ts`.

## Status

**Pre-alpha (Phase 1 scaffold).** Only `ping` is implemented today; the auth flow and
tool commands land in later phases. Interfaces may change without notice.

## Development

```bash
npm install
npm run dev -- ping --staging --json   # run from source
npm run typecheck
npm test
npm run build
```
