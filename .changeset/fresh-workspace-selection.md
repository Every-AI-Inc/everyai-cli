---
"@everyai/cli": minor
---

Add `every org switch` and `every login --org` to select a workspace through the browser consent page and optionally verify its id, slug, or name before replacing credentials. Login now reports the bound workspace, and failed verification preserves the previous login.

Fix stale identity after browser login by immediately refreshing the userinfo cache, or invalidating it when plain login cannot reach userinfo. Workspace switches are isolated by environment and restore previous credentials if storage fails.
