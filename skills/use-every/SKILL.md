---
name: use-every
description: Drive the Every AI CLI (`every`) to manage the user's business — invoices, clients, contacts, proposals, deals, pipeline, payments. Use when the user asks to look up, create, update, or send any of those, or mentions their Every workspace.
---

# Use Every

## Setup Check

Run `every --version` first. If the CLI is missing, suggest `npm install -g @everyai/cli`. If any authenticated command exits `3`, tell the user to run `every login` (it opens their browser; you cannot complete it for them).

## What Every Is

Use Every as an SMB business-ops workspace for invoices, clients, contacts, proposals, deals, payments, and pipeline work.

Use the `every` CLI as authenticated access to the user's Every workspace from any coding agent shell. Assume the user must have run `every login` once before authenticated commands can work.

## Conventions

Always pass `--json`. Parse the envelope every time:

- `ok: true` means read `data`.
- `ok: false` means read `error.code` and `error.message`.
- `env` tells you whether the command targeted `production`, `staging`, or `custom`.
- `schema_version` must be present and understood before automating against the response.

Check process exit codes:

- `0`: success.
- `2`: usage error. Fix the command or arguments.
- `3`: auth error. Tell the user to run `every login`.
- `4`: permission or confirmation needed. Ask the user before adding confirmation flags.
- `5`: rate limited. Back off and retry later.
- `6`: not found. Re-list records and verify the ID.
- `7`: network error. Retry after checking connectivity.

Never infer or guess IDs. List first, then act only with the exact ID shown in the result, such as `[id: ...]`.

## Discovery

Use these commands to discover current tools and policy:

```bash
every docs
every tools list --json
every tools describe <name> --json
every policy explain <name> --json
```

## Safety Rules

Run read tools freely.

For WRITE tools, add `--yes` only when the human user explicitly asked for the change.

For DESTRUCTIVE tools, including sends, deletes, voids, and payments, add both `--yes` and `--allow-destructive` only when the human user explicitly asked for that external or irreversible action. Never add `--allow-destructive` unprompted.

`every whoami --json` reports the authenticated user, org, environment, base URL, and tool count. Write results echo the target org so you can confirm the blast radius before trusting the result.

In automation, prefer `--read-only` unless writes were requested.

Treat `ask_assistant` as AI-mediated. It routes to Every's agent and can act on the account. Prefer deterministic tools. Do not use `ask_assistant` in read-only automation.

## Canonical Workflows

Review pipeline:

```bash
every deal list --json
every tool call view_deal --arg deal_id=<id> --json
```

Move a deal:

```bash
every deal move <id> <stage> --yes --json
```

Invoice flow:

```bash
every invoice list --status overdue --json
every tool call create_invoice --arg client_id=<id> --arg line_items='[{"description":"Work","quantity":1,"unit_price":100}]' --yes --json
every invoice send <id> --yes --allow-destructive --json
```

Contacts:

```bash
every contact list --search "acme" --json
```

## Recovery And Debug

Use these commands when auth, identity, or connectivity is unclear:

```bash
every auth status --json
every whoami --json
every ping --json
every logout && every login
```

## Staging

Use `--staging` only for Every's staging environment. Treat it as internal/testing only.
