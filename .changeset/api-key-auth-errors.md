---
"@everyai/cli": patch
---

Fix two errors that told an API-key user the wrong thing. `every whoami` and `every org` resolved identity through the Clerk OAuth userinfo endpoint, which cannot see an `evk_` org API key, so a valid key reported "Not logged in. Run 'every login'." — the browser flow the key exists to avoid. Both commands now verify the key against the MCP server and report that the caller is authenticated via an API key, with the environment and the key's scope-filtered tool count.

Any MCP 401 was also reported as a missing login. A rejected API key now says so, quotes the server's own reason, names the real causes (invalid, expired, revoked, or a creator who is no longer an org admin) and links Settings -> API keys. OAuth sessions keep the existing message. `every auth status` no longer tries to read an expiry out of a key, and a gated tool call no longer warns that it "could not verify target org" when running under a key.
