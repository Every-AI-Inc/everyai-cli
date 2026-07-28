# @everyai/cli

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
