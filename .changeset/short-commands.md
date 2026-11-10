---
"@everyai/cli": minor
---

Short commands for Companies, People, Deals, deal outreach and approvals. Each one calls one tool, with the same `--json` envelope, exit codes and safety gates as the other short commands. `every tool call <tool>` stays valid for every tool.

- `every company list [--search] [--limit]`, `every company view <id>` and `every company create --name <name>` with `--email`, `--phone`, `--website`, `--industry`, `--address`, `--lead-source` and `--notes`.
- `every person view <id>` and `every person create --name <name>` with `--email`, `--phone`, `--job-title`, `--company`, `--location`, `--headline`, `--industry`, `--address` and `--notes`. `every person list` is unchanged.
- `every deal view <deal_id> [--plan] [--draft] [--auto-sends]` adds the open plan steps, the unsent draft with its draft version, and the scheduled sends.
- `every deal create` takes `--person-id`, `--company-id`, or `--name` and `--email` for a new Person, plus `--stage`, `--deal-name`, `--value`, `--owner` and `--goal`.
- `every deal update <deal_id>` changes only the fields you pass: `--name`, `--value`, `--owner`, `--person-id` or `--company-id`, `--add-member` and `--remove-member`. A call with no change is refused. A goal change stays on `every tool call update_deal`, because the server replaces the whole goal.
- `every deal list` adds `--attention` (`needs_reply`, `step_due`, `draft_ready`, `stale`, repeat it or use a comma list), `--stale-days`, `--owner` and `--mine`, `--since` and `--sort last_activity_at`. With these flags, the human output is a table with the last activity and the next step. A call without them sends the same arguments and prints the same output as before.
- `every deal outreach edit <deal_id>` (`--subject`, `--body` or `--body-file`, `--recipient`, `--thread`) and `every deal outreach cancel <deal_id> --send-id <id>` are ordinary writes: `--yes` without a TTY.
- `every deal outreach send <deal_id>` reads the draft, shows its channel, recipient, subject and text, and sends that exact draft version. `--draft-version <v>` sends a version you already have. It is destructive: `--yes --allow-destructive` without a TTY. Every then holds the send for the owner: exit `4`, `error.mcp_gate`, and `error.approvals_url` with the Settings > Approvals link.
- `every approvals [--all]` lists the requests that wait for approval in Every: status, tool, deal id and action, the connection that asked, and the created and expiry times. By default it shows the pending and approved requests of this connection. `--all` shows every request of the last 24 hours. It exits `0` with a clear message when the server cannot report approvals.
- `every tool call deal_outreach` stays destructive for every action. `every policy explain deal_outreach` now says that the short commands gate by action.
- The bundled `use-every` skill lists the short commands and their tools.
