---
"@everyai/cli": minor
---

Teach agents to run the deals and prospects pipeline on a schedule, and classify the two new deal tools locally.

- The bundled `use-every` skill now has two parts. **General use** is the skill as before. **Agent automation** is the routine for a scheduled agent: start each run with `get_workspace_priorities` and its `pending_approvals`, sweep `list_deals` with the `attention` filters and `updated_since`, read `view_deal` with `include` and `view_entity_timeline` with `after`, edit and send the deal's message with `deal_outreach` (`draft_version`), close plan steps with `log_deal_activity` `plan_action_outcome`, move stages with a `reason`, prune with `archive_records` and `restore_records`, and approve, merge or reject prospects. A send waits for the owner in Settings → Approvals for up to 24 hours, and the next run repeats the identical call.
- `update_deal` replaces `set_deal_name` and `set_deal_value_estimate`, which stay as deprecated aliases on the server. The skill teaches `update_deal`.
- Local policy: `update_deal` is pinned to write. `deal_outreach` is pinned to destructive for all actions, because it can send a message to real recipients and its name does not match the `send_` rule. Non-interactive calls need `--yes --allow-destructive`; the server approval still applies.
