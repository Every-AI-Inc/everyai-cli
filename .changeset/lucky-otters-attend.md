---
"@everyai/cli": patch
---

Classify the four new client-deal tools locally instead of trusting server annotations: `create_client_deal`, `set_deal_title`, and `link_deal_item` are pinned to write (`--yes`), and `unlink_deal_item` to destructive (`--yes --allow-destructive`), matching the tier of `unlink_contact_from_client` because the automatic matcher never re-links what you unlink. The read-only `get_deal_burn` still classifies from its annotation and runs freely.
