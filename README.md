# @everyai/cli

The **agent-agnostic** command line for [Every AI](https://every.ai) — manage invoices, People, Companies, proposals, deals, and pipeline work from any shell, coding agent, or CI job.

Install once, log in once, and teach each coding agent the same `every` command instead of wiring MCP + OAuth separately into every host.

```bash
npm install -g @everyai/cli
every docs                         # offline command tree, output contract, workflows
every signup                       # new to Every? one browser step creates your account (an agent can run this for you)
every login                        # existing users at an interactive terminal
every skills install claude|codex  # teach Claude Code or Codex how to use Every
every whoami                       # user, org, environment, tool-count check
```

One-shot invoice example with inline args:

```bash
every invoice list --status overdue --json
every tool call create_invoice \
  --arg command='{"operation_id":"<uuid>","party":{"kind":"company","id":"<company_id>"},"line_items":[{"description":"Strategy work","quantity":1,"unit_price":1500}]}' \
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
- **Safety gates** — reads run freely; writes require `--yes`; destructive actions (sends, deletes, voids, payments) additionally require `--allow-destructive`; `--read-only` (or `EVERY_READ_ONLY=1`) locks everything else out. Classifications are enforced locally — including for tools whose server annotations are too optimistic. When trusted MCP metadata asks for an ordinary-write text confirmation, the CLI forwards the server's exact phrase and retries once.
- **Deterministic output** — a stable `--json` envelope and exit-code taxonomy an agent can parse and branch on.

## Commands

```bash
# Auth
every signup [--timeout <seconds>]   # new account or sign-in via one browser step; works without a TTY
every signup status
every signup complete --org-name <name> [--description <text>] [--link <url> ...] --yes
every login [--org <name|slug|id>] [--staging]  # browser OAuth; keychain storage; refresh handled
                                              # (--create-account is a deprecated alias for every signup)
every logout | whoami | auth status
every org [switch --org <name|slug|id>]

# Discovery
every docs
every tools list [--filter <substr>] [--no-cache]
every tools describe <name>
every policy explain <name>    # classification + exactly what running it requires

# Run any tool
every tool call <name> [--args file.json|-] [--arg k=v ...] [--yes] [--allow-destructive] [--read-only]

# Curated aliases (same gates, nicer flags)
every invoice list [--status <s>] [--search <q>] [--limit <n>]
every invoice create (--company <name> | --person <name> | --company-id <id> | --person-id <id>) --amount <n>
                                           # write: needs --yes
every invoice send <invoice_id>            # destructive: needs --yes --allow-destructive
every deal list [--stage <s>] [--search <q>]
every deal move <deal_id> <stage>          # write: needs --yes
every person list [--search <q>]           # People

# Teach your coding agent to use all of this well
every skills install claude    # → .claude/skills/use-every/
every skills install codex     # → .agents/skills/use-every/
```

Deprecated aliases still work and print a one-line note to stderr: `every contact list` (use `every person list`) and `every invoice create --client <name>` / `--client-id <id>` (use `--company`, `--company-id` or `--person-id`). They are hidden from help and `every docs`.

## Signing up

`every signup` creates an Every account, or signs an existing user in, through a single browser authorization. It never opens a separate sign-up page and never waits for Enter, so a coding agent can run it on the user's behalf without a TTY:

1. It prints the authorization URL first, tries to open the browser, then waits on a local loopback callback for up to `--timeout` seconds (default 300). With `--json`, stdout is NDJSON: `{"event":"authorization_required","url":"..."}`, then `{"event":"waiting_for_authorization","browser_opened":true|false,"timeout_seconds":300}`, then the usual envelope as the last line. If `browser_opened` is false, open the printed URL yourself.
2. After the browser step it reports the server's signup status: `signup_status` is `ready` for an account that is good to go, or `needs_profile` with the one required field (`organization_name`) and unverified `profile_suggestions` to confirm with the user.
3. `every signup complete --org-name "<name>" [--description "<text>"] [--link <https url> ...] --yes` saves the confirmed profile and returns `account_ready: true`. Background setup (Business DNA and friends) is reported separately and never blocks the account. It is an ordinary write: `--yes` when non-interactive, never `--allow-destructive`.

`every signup status` re-reads the state at any time. Signup commands always fetch a fresh tool list. A server without agent signup yields exit `6` with `error.code: "signup_unsupported"` ("this server does not support agent signup yet"). Denials and timeouts exit `3`; rerun `every signup`. While signup is unfinished, other tools are refused with `error.code: "signup_incomplete"`, and the CLI says which commands finish it. `EVERY_TOKEN` is never a signup path.

The CLI sends the RFC 8707 `resource` parameter (the MCP server's canonical URL from its protected-resource metadata) on the authorization request, the code exchange and every refresh.

After a successful `every signup` or `every login`, the CLI updates any copy of the `use-every` skill it installed earlier whose revision stamp is older than the bundled one. It never installs a copy where none exists and skips symlinked installs.

`every login` remains the interactive login for existing users; `every login --create-account` still works as a deprecated alias for `every signup`.

## Switching workspaces

Run `every org switch` and pick the workspace in the browser consent page's selector. The token binds one workspace per environment; add `--staging` to switch staging. Use `every org switch --org "<name|slug|id>"` (or `every login --org "<name|slug|id>"`) to verify the selection after login. `--org` does not preselect a workspace; a mismatch keeps your previous credentials. Names can be ambiguous, so use the workspace id when needed. Verify the result with `every whoami --json`. Unset `EVERY_TOKEN` before switching because it overrides stored credentials.

## Output contract

Every command supports `--json`: exactly one JSON document on stdout, nothing else.

```jsonc
{ "ok": true,  "data": { /* ... */ }, "env": "production", "schema_version": 1 }
{ "ok": false, "error": { "message": "...", "code": "..." }, "env": "production", "schema_version": 1 }
```

Exit codes: `0` ok · `1` tool/generic error · `2` usage · `3` auth (run `every signup`, or `every login` at a terminal) · `4` permission/confirmation needed · `5` rate-limited · `6` not found · `7` network/timeout.

When a tool refuses (exit `1`) and the server attached a structured error, `error.code` is the server's stable, machine-readable code — e.g. `duplicate_deal`, `party_unresolved`, `contact_suppressed`, `deal_archived`, `person_has_references` — and `error.tool_error` carries the server's full error object (e.g. `existing_deal_id`). Branch on the code, never on the message. Servers that send no structured error still produce `error.code: "generic"`. Successful creates return the new record's id in `data.structured_content` (e.g. `structured_content.deal.id`).

Server-side human approvals never trigger an automatic destructive retry. If Every shows a pending approval after a destructive call returns or times out, approve it there and then re-run the identical command. The CLI sends one `tools/call` per invocation for a human-approval-gated action, and a still-valid approval can be consumed by that later invocation.

In `--json` mode, a server approval response uses exit `4` and includes a structured `error.mcp_gate` object. After local `--yes` or interactive consent, `type: "text_confirmation"` is retried once automatically; `type: "human_approval"` is returned to the caller without retrying.

## Headless / CI

Set `EVERY_TOKEN` to a valid access token to skip the browser flow entirely. `login` requires a TTY by design and fails fast (exit `3`) without one; `signup` does not need one.

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
