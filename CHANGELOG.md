# @everyai/cli

## 0.3.0

### Minor Changes

- Skill excellence and install UX: fact-checked Every workflows and domain safeguards, an optional post-login agent-skill offer, host-aware hints and install guidance, plus Claude Code plugin metadata and Codex marketplace guidance.

## 0.2.0

### Minor Changes

- Agent-DX release, from a real cold-start agent trace (13 round-trips → ≤5, now enforced by a CI eval): `whoami`/`org` report who you are and where writes land (email, org id/name/slug via OIDC userinfo, environment); every `--json` envelope carries `env` and gated writes echo the target `org`; `every invoice create --client "<name>" --amount <n>` with fuzzy client resolution (ambiguity → mechanical `error.candidates`); discovery loop closed (postinstall notice, login next-steps, one-time skill hint, first-run welcome menu, README agent quickstart); `everyai` bin alias; `tools list --filter`; one-shot offline `every docs`; breadcrumbs teach inline `--arg`/`--args -`; `EVERY_ENV` + `XDG_CONFIG_HOME` support.

## 0.1.0

### Minor Changes

- First release: browser OAuth login (PKCE + OS keychain + refresh), full Every tool surface via MCP (`tools list/describe`, `tool call`), local safety policy (read-only default gates, `--yes`/`--allow-destructive`, `--read-only` mode, `policy explain`), curated aliases (`invoice list/send`, `deal list/move`, `contact list`), stable `--json` envelope + exit-code contract, and the installable `use-every` skill for Claude Code and Codex (`every skills install`).
