---
"@everyai/cli": minor
---

One agent-run `every signup` now leaves the person with an account and the Every skill.

- `every signup` with `--json` or without a TTY installs the bundled `use-every` skill at user level for each coding agent it detects that has no copy: Claude Code (`~/.claude` → `~/.claude/skills/use-every`) and Codex (`~/.codex` or `~/.agents` → `~/.agents/skills/use-every`). This applies to new and existing accounts. The last line reports the result in `data.skill` (`installed`, `already_present`, `failed`, `skipped_reason`). An install failure prints a warning and never fails the signup. `--no-skill` skips the install, and an earlier declined offer is respected. The interactive offer at a terminal is unchanged.
- The first NDJSON event of `every signup --json` now carries `timeout_seconds` and `guidance`: the command waits up to 300 seconds for the browser step, so an agent must run it in the background or allow at least 5 minutes.
- When the account is not ready, `every signup` and `every signup status` state the next step in plain words (`data.next_step` with `--json`): ask the person for the organization name, then run `every signup complete --org-name "<name>" --yes --json`.
- The install notice now says `Get started: every signup`. `every login` needs a terminal and cannot create an account.
- Claude Code plugin: added `.claude-plugin/marketplace.json`, so `/plugin marketplace add Every-AI-Inc/everyai-cli` and `/plugin install every@everyai-cli` work. Before, the marketplace file was missing and the add failed.
- The `use-every` skill (revision 8) and the README describe the new signup behavior.
- A command that has no credential now says `Not logged in. Run 'every signup' (or 'every login' at a terminal).` Before, it named only `every login`, which an agent cannot run.
