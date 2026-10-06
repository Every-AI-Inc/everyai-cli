# @everyai/cli

## 0.8.1

### Patch Changes

- b449f81: The CLI now uses Every's current names, the same ones the in-app agent uses. `every person list [--search <q>] [--limit <n>]` lists People through `list_people`. `every contact list` still works as a hidden, deprecated alias and prints a one-line note to stderr. `every invoice create` takes `--company-id <id>` or `--person-id <id>` to name the recipient without a name search. `--client-id` (a Company unless `--person` names a Person, as before) and `--client` (an alias for `--company`) still work as hidden, deprecated aliases with a one-line stderr note. Conflicting recipient flags are a usage error, and an ambiguous name now says which id flag to use. Help and `every docs` list only the current names; with `--json`, stdout is still one envelope.

  The local safety policy follows the admin MCP renames. `set_deal_name` (formerly `set_deal_title`) stays pinned to the write tier, and `approve_prospect` is pinned to write next to `approve_pending_deal`, which the server keeps. `void_invoice` (formerly `delete_invoice`; it voids and never deletes) stays destructive through the `void_` name rule. The bundled `use-every` skill is now revision 3, so installed copies refresh on the next `every login` or `every signup`. It teaches `approve_prospect` (the owner/bookkeeper review action) and `approve_pending_deal` (the API-key path), `merge_prospect` with `into_deal_id`, `reject_prospect`, `view_prospect` with `prospect_id`, `network_summary` with `target_id`, `list_prospects` with `status=rejected`, `set_deal_name`, `set_deal_value_estimate`, `void_invoice`, the `recurring` section of `get_financial_report`, and the new recipient flags. The test fixtures that mirror the server's tool surface carry the new tool names.

- 1786f36: `get_heartbeat_summary` is retired. It read the stored result of the "pipeline_heartbeat" routine, which no longer runs, so it returned stale or empty data. Read a scheduled task's latest completed result with `get_scheduled_task_result` instead, passing a `task_id` from `list_scheduled_tasks`. It is read-only, it does not run the task, and the CLI treats it as a free read, like `get_daily_brief`. The bundled `use-every` skill and the test fixtures that mirror the server's tool surface now name the new tool.

## 0.8.0

### Minor Changes

- 0035f83: Add `every signup`, `every signup status` and `every signup complete` so a coding agent can sign a user up for Every on their behalf. `every signup` runs one browser OAuth authorization and works without a TTY: it prints the authorization URL first (with `--json`, as the first NDJSON line `{"event":"authorization_required","url":...}`), tries to open the browser, waits on the loopback for up to `--timeout` seconds (default 300), then reports the server's `get_signup_status` envelope. It never opens the web sign-up page and never waits for Enter. `every signup complete --org-name <name> [--description <text>] [--link <url> ...] --yes` commits the profile the user confirmed through `complete_signup`, with the usual one-retry text confirmation and no `--allow-destructive`. All three bypass the tools cache; a server without the tools exits `6` with `error.code: "signup_unsupported"`. Any tool refused with `signup_incomplete` now tells the caller to run `every signup status` / `every signup complete`.

  `every login --create-account` is now a deprecated alias for `every signup` (the note appears in human output only), as is the "Create an account" menu choice. Plain `every login` and `EVERY_TOKEN` are unchanged; `EVERY_TOKEN` is never a signup path.

  OAuth now sends the RFC 8707 `resource` parameter (the canonical MCP resource URL from protected-resource metadata, falling back to the MCP base URL) on the authorization request, the code exchange and the refresh.

  The bundled `use-every` skill carries a revision stamp (`metadata.every-skill-version`), and `every signup`/`every login` refresh installed copies whose stamp is older or missing, in the locations the installer already knows, without installing anywhere new. The skill now tells agents to run the signup flow themselves, ask one combined profile question, and never ask for passwords, codes or tokens.

## 0.7.2

### Patch Changes

- d7be8bd: Tool refusals now carry the server's stable error code. When a tool call fails and the Every server attaches a structured error (`structuredContent.error`), `error.code` in the `--json` envelope is that code (e.g. `duplicate_deal`, `party_unresolved`, `contact_suppressed`) and `error.tool_error` holds the server's full error object (e.g. `existing_deal_id`). Exit code stays `1`. Servers that send no structured error keep producing `error.code: "generic"`, so this is backward compatible. README and the bundled `use-every` skill document branching on the code.

## 0.7.1

### Patch Changes

- fdc1913: Fix two errors that told an API-key user the wrong thing. `every whoami` and `every org` resolved identity through the Clerk OAuth userinfo endpoint, which cannot see an `evk_` org API key, so a valid key reported "Not logged in. Run 'every login'." — the browser flow the key exists to avoid. Both commands now verify the key against the MCP server and report that the caller is authenticated via an API key, with the environment and the key's scope-filtered tool count.

  Any MCP 401 was also reported as a missing login. A rejected API key now says so, quotes the server's own reason, names the real causes (invalid, expired, revoked, or a creator who is no longer an org admin) and links Settings -> API keys. OAuth sessions keep the existing message. `every auth status` no longer tries to read an expiry out of a key, and a gated tool call no longer warns that it "could not verify target org" when running under a key.

## 0.7.0

### Minor Changes

- 5292a14: Add `every org switch` and `every login --org` to select a workspace through the browser consent page and optionally verify its id, slug, or name before replacing credentials. Login now reports the bound workspace, and failed verification preserves the previous login.

  Fix stale identity after browser login by immediately refreshing the userinfo cache, or invalidating it when plain login cannot reach userinfo. Workspace switches are isolated by environment and restore previous credentials if storage fails.

## 0.6.5

### Patch Changes

- 80fb6cb: Fixed retired-tool errors from the 2026-09-09 People/Companies migration. `every invoice create --client`, `every contact list`, and the bundled `use-every` skill's lead-intake example all called MCP tools (`list_clients`, `list_contacts`, `create_contact`) that the server now rejects with "This tool is retired." They now call the live replacements (`list_companies`, `list_people`, `create_person`) with the current `query` search parameter.

  - `--client <name>` on `invoice create` still works (deprecated alias); `--company <name>` is the preferred spelling, and a new `--person <name>` resolves via `list_people` for a Person recipient.
  - The local write-tier override for the retired `create_client_deal` now targets its live replacement, `create_delivery_deal`.
  - Test fixtures now mirror the live 98-tool surface (was pinned to a stale 85-tool snapshot that still listed the nine retired Client/Contact tools and was missing all twelve live People/Companies tools).

- 80fb6cb: Fixed a second, deeper break from the same migration: `create_invoice` no longer accepts a flat `client_id`. The server now requires a structured `command: {operation_id, party: {kind, id}, line_items, ...}` and rejects the old shape with "client_id is retired on this tool." `every invoice create --client/--company/--person` now resolves the recipient's kind (Person or Company) and builds that structured payload, generating a fresh `operation_id` UUID per write that is reused only for the server's own confirmation retry (never minted twice for one logical write). A bare `--client-id` with no `--company`/`--person` alongside it defaults to a Company party, matching this CLI's historical "client" meaning. The test fixture's `create_invoice` schema and mock server now reflect the structured shape, and dedicated tests prove the built payload against that schema so a reintroduced flat `client_id` fails loudly instead of shipping quietly again.

## 0.6.4

### Patch Changes

- cd53b6d: Classify the four new client-deal tools locally instead of trusting server annotations: `create_client_deal`, `set_deal_title`, and `link_deal_item` are pinned to write (`--yes`), and `unlink_deal_item` to destructive (`--yes --allow-destructive`), matching the tier of `unlink_contact_from_client` because the automatic matcher never re-links what you unlink. The read-only `get_deal_burn` still classifies from its annotation and runs freely.

## 0.6.3

### Patch Changes

- 1a505bc: Support admin-MCP approval gates: retry ordinary writes once using trusted MCP metadata and the server's exact confirmation, surface human approvals without auto-retrying destructive actions, and improve timeout guidance.

## 0.6.2

### Patch Changes

- ce74bb5: OAuth conformance with MCP spec revision 2026-07-28.

  Dynamic Client Registration now declares `application_type: 'native'`. The CLI is
  a native app authorizing through a loopback redirect, and saying so keeps an
  OIDC-compliant server from rejecting the `http://127.0.0.1` redirect URI that web
  clients are not allowed to use.

  The authorization response's `iss` is now validated against the issuer found
  during discovery (RFC 9207), which closes the mix-up case where a callback is
  replayed from a different authorization server. A callback that omits `iss`
  still completes, since not every server sends it and rejecting those would break
  otherwise-valid logins.

## 0.6.1

### Patch Changes

- Publish with a provenance attestation.

  The repository is now public, which npm requires before it will accept a provenance attestation. Every release from here carries a signed, publicly verifiable link from the tarball on npm back to the exact commit and CI run that produced it — check it with `npm audit signatures`.

## 0.6.0

### Minor Changes

- 61d267b: Track the 85-tool Every MCP surface.

  The server surface grew from 78 to 85 tools: custom fields (define, read, set and search, including tags), scheduled tasks (list, create, cancel), record timelines, entity counts, read-only pipeline settings, and pending-deal approval. The six retired Bookings tools are gone.

  Tools are discovered at runtime, so they were already reachable — this release brings the local state that does not auto-update into line:

  - `approve_pending_deal` is pinned to the write tier by an explicit name-based override. It activates a deal and queues its plan, which is hard to undo, and the server marks it non-destructive — so without this its safety tier would depend entirely on that annotation staying correct.
  - The bundled `use-every` skill no longer teaches the removed booking tools, and documents the custom-fields and scheduled-task workflows.
  - Test fixtures now mirror the real 85-tool surface with annotations read from the live server rather than hand-written.

## 0.5.0

### Minor Changes

- Added logged-out account menus to bare `every` and `every login`, plus `every login --create-account`, which deep-links to the correct signup page and automatically connects the CLI after browser signup.

### Patch Changes

- Fixed the bare-`every` first-run menu never appearing: commander's empty-args help short-circuited before the menu could run, so logged-out users went straight to help text.

## 0.4.0

### Minor Changes

- Prepared the CLI for the 78-tool admin-MCP surface: Gmail, calendar, booking, prospecting, daily brief and heartbeat, financial reporting, and recurring invoice workflows.
- Updated local policy gates so reads run freely, ordinary writes (including non-destructive open-world actions) require `--yes`, and sends, cancellations, and immediate recurring-invoice runs require `--yes --allow-destructive`.
- Added concise agent guidance for the new domains and clarified that `ask_assistant` is server-enforced read-only while deterministic tools remain preferred.

## 0.3.0

### Minor Changes

- Skill excellence and install UX: fact-checked Every workflows and domain safeguards, an optional post-login agent-skill offer, host-aware hints and install guidance, plus Claude Code plugin metadata and Codex marketplace guidance.

## 0.2.0

### Minor Changes

- Agent-DX release, from a real cold-start agent trace (13 round-trips → ≤5, now enforced by a CI eval): `whoami`/`org` report who you are and where writes land (email, org id/name/slug via OIDC userinfo, environment); every `--json` envelope carries `env` and gated writes echo the target `org`; `every invoice create --client "<name>" --amount <n>` with fuzzy client resolution (ambiguity → mechanical `error.candidates`); discovery loop closed (postinstall notice, login next-steps, one-time skill hint, first-run welcome menu, README agent quickstart); `everyai` bin alias; `tools list --filter`; one-shot offline `every docs`; breadcrumbs teach inline `--arg`/`--args -`; `EVERY_ENV` + `XDG_CONFIG_HOME` support.

## 0.1.0

### Minor Changes

- First release: browser OAuth login (PKCE + OS keychain + refresh), full Every tool surface via MCP (`tools list/describe`, `tool call`), local safety policy (read-only default gates, `--yes`/`--allow-destructive`, `--read-only` mode, `policy explain`), curated aliases (`invoice list/send`, `deal list/move`, `contact list`), stable `--json` envelope + exit-code contract, and the installable `use-every` skill for Claude Code and Codex (`every skills install`).
