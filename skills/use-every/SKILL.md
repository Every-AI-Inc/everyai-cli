---
name: use-every
description: Drive the Every AI CLI (`every`) to manage the user's service business — invoices, clients, contacts, proposals, deals, pipeline, payments, services, and bookings. Use when the user asks “who owes me money?”, wants a lead or deal follow-up, asks to look up, create, update, convert, or send a business record, or mentions their Every workspace.
---

# Use Every

## Setup Check

Run `every --version` first. If the CLI is missing, suggest `npm i -g @everyai/cli`. If any authenticated command exits `3`, tell the user to run `every login` (it opens their browser; you cannot complete it for them).

For headless use, accept `EVERY_TOKEN` from the environment instead of browser login. Never print, log, or persist the token.

## What Every Is

Use Every as a service-business workspace for the sales pipeline, deals, contacts and clients, proposals, invoices, payments, services, and bookings. The authenticated CLI operates on one connected Every workspace at a time. If the user means a different business, tell them to switch accounts in Every.

## Required Workflow

1. Resolve records with list/view commands. Never guess an ID; use the exact ID returned in `[id: ...]`. If a name is ambiguous, show the candidates and ask.
2. Before a write, state exactly what will be created or changed, including amounts and recipients.
3. Get explicit approval before anything client-visible or financially consequential, including sends, deletes, voids, and recording payments.
4. Execute with complete inputs, then echo the returned number, status, total, and `public_url`. Suggest the natural next step. Share only `public_url` links with clients, never internal IDs.

## CLI Contract

Always pass `--json`. Parse the envelope every time:

- `ok: true` means read `data`.
- `ok: false` means read `error.code` and `error.message`.
- `env` tells you whether the command targeted `production`, `staging`, or `custom`.
- `schema_version` must be present and understood before automating against the response.

Check process exit codes:

- `0`: success.
- `1`: tool or generic error. Read the error message before deciding whether to retry.
- `2`: usage error. Fix the command or arguments.
- `3`: auth error. Tell the user to run `every login`.
- `4`: permission or confirmation needed. Ask before adding confirmation flags.
- `5`: rate limited. Back off and retry later.
- `6`: not found. Re-list records and verify the ID.
- `7`: network error. Retry after checking connectivity.

Use current tool schemas rather than assuming arguments:

```bash
every docs
every tools list --json
every tools describe <name> --json
every policy explain <name> --json
```

## Safety Rules

Run read tools freely.

For WRITE tools, add `--yes` only when the human explicitly asked for the change.

For DESTRUCTIVE tools, including sends, deletes, voids, and payments, add both `--yes` and `--allow-destructive` only when the human explicitly asked for that external or irreversible action. Never add `--allow-destructive` unprompted.

Use `every whoami --json` to verify the authenticated user, org, environment, base URL, and tool count. Write results echo the target org; confirm the blast radius before trusting them. In automation, prefer `--read-only` unless writes were requested.

`ask_assistant` is a server-enforced read-only analytical fallback; prefer deterministic tools for actions.

## Domain Rules

### Deal activity auto-tracking is creation-only

Creating a proposal, invoice, or booking automatically records activity on a matching deal when exactly one deal/client matches. After an Every creation command, never double-log that action:

```bash
every invoice create --client-id <client_id> --amount 100 --yes --json
every tool call create_proposal --args proposal.json --yes --json
```

Use `log_deal_activity` ONLY for a completed outside event the user reports, such as a call, meeting, or email/DM thread. Never use it for an action performed through Every tools:

```bash
every deal list --search "Acme" --json
every tool call log_deal_activity --arg deal_id=<deal_id> --arg note="Call completed; client approved scope" --yes --json
```

### Won deals require completed client promotion

Pipeline stages are `lead`, `opportunity`, `won`, and `lost`:

```bash
every deal move <deal_id> won --yes --json
```

Moving to `won` requires completed client promotion. No CLI or chat tool can set that promotion. If the command returns a client-resolution error, tell the user to finish converting the contact to a client in the Every app, then retry the same command.

### Invoice rates and tax

Treat `unit_price` as the per-unit rate, not the line total. The simple CLI's `--amount` maps to that per-unit rate:

```bash
every invoice create --client-id <client_id> --description "Workshop" --quantity 3 --amount 100 --yes --json
every tool call create_invoice --arg client_id=<client_id> --arg line_items='[{"description":"Workshop","quantity":3,"unit_price":100}]' --yes --json
```

Leave `sales_tax_applied` unset so the business default applies. Never add tax as a line item. When currency, tax, or timezone matters, read settings first with `every tool call business_settings --json`; let Every compute tax, numbering, due dates, and totals.

### Proposal to invoice

Only issued or approved proposals convert. View the proposal first, use the conversion tool so the linkage is preserved, and never re-create the invoice manually:

```bash
every tool call view_proposal --arg identifier=<proposal_id> --json
every tool call convert_proposal_to_invoice --arg proposal_id=<proposal_id> --yes --json
```

Conversion creates a linked DRAFT invoice. Review the returned invoice ID, then send only after the user approves:

```bash
every tool call view_invoice --arg identifier=<invoice_id> --json
every invoice send <invoice_id> --yes --allow-destructive --json
```

### Invoice re-sends

`send_invoice` re-sends the invoice email itself; it does not send custom reminder copy. For an overdue follow-up, confirm with the user, re-send the invoice, and give any custom message separately for the user to send:

```bash
every invoice send <invoice_id> --yes --allow-destructive --json
```

### Gmail is draft-first

Prefer `draft_email` so the user can review recipients and copy. `send_email` sends immediately from the user's own mailbox; use it only after explicit approval with both destructive flags.

### Calendar and booking ownership

Calendar tools operate on the user's personal calendar. Confirm attendees and timezone before creating; reschedules and cancellations can notify attendees according to `send_updates`, so state that effect before acting.

Booking create, reschedule, and cancel tools are owner-actions. Resolve the booking and check availability first, then confirm the customer-visible time change or cancellation before executing it.

### Prospecting reads

Use `list_prospects`, `view_prospect`, and `network_summary` to research the user's network. Treat the returned personal and relationship context as private; these tools do not contact prospects.

### Stored briefs and reports

`get_daily_brief` and `get_heartbeat_summary` read stored artifacts for the authenticated caller only; do not imply they regenerate or share a brief. Use `get_financial_report` for the server-computed financial view and preserve its reported period and currency.

### Recurring invoices

List and inspect recurring invoices before changing their schedule or status. Creating, updating, pausing, and resuming are writes; `run_recurring_invoice_now` is destructive because it may auto-send an invoice email when that schedule is configured to send.

### Complete money totals

For invoice counts or money totals, filter `overdue` and `issued` separately and paginate until every result is fetched. Never total one default page; it gives confidently wrong numbers. Use the full tool so you can increment `offset` by `limit` until a page returns fewer records than the limit:

```bash
every tool call list_invoices --arg payment_status=overdue --arg limit=100 --arg offset=0 --json
every tool call list_invoices --arg status=issued --arg limit=100 --arg offset=0 --json
```

Repeat each command with offsets `100`, `200`, and so on until complete. Report the two filtered totals separately unless the user asks for a different calculation.

## Canonical Workflows

Review the pipeline:

```bash
every tool call get_pipeline_summary --json
every deal list --stage opportunity --json
every tool call view_deal --arg deal_id=<deal_id> --json
every deal move <deal_id> <stage> --yes --json
```

Recommend follow-ups before moving anything. Log only outside events the user reports; creation of proposals, invoices, and bookings is already tracked.

Invoice flow: find who owes money:

```bash
every tool call list_invoices --arg payment_status=overdue --arg limit=100 --arg offset=0 --json
every tool call list_invoices --arg status=issued --arg limit=100 --arg offset=0 --json
every tool call view_invoice --arg identifier=<invoice_id> --json
```

Paginate both filtered lists completely, then report client, invoice number, balance, due date, and totals. Offer to re-send an invoice after confirmation or record a payment only when the user reports it received.

Convert an accepted proposal:

```bash
every tool call view_proposal --arg identifier=<proposal_id> --json
every tool call convert_proposal_to_invoice --arg proposal_id=<proposal_id> --yes --json
every tool call view_invoice --arg identifier=<invoice_id> --json
every invoice send <invoice_id> --yes --allow-destructive --json
```

Stop if the proposal is not issued/approved. Review the linked draft and obtain approval before sending.

Intake a new lead:

```bash
every contact list --search "person@example.com" --json
every tool call create_contact --args contact.json --yes --json
every tool call create_deal --args deal.json --yes --json
```

Search contacts first because email deduplication is real. Create only missing records, then progress the deal as the relationship develops.

For a general activity snapshot, combine complete/paginated invoice reads with recent payments and expenses. Use the currency from `business_settings`; if any source is only a partial page, describe it as recent activity rather than a definitive cash position.

## Recovery and Debugging

Use these commands when auth, identity, or connectivity is unclear:

```bash
every auth status --json
every whoami --json
every ping --json
every logout && every login
```

Use `--staging` only for Every's staging environment. Treat it as internal/testing only.
