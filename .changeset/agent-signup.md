---
"@everyai/cli": minor
---

Add `every signup`, `every signup status` and `every signup complete` so a coding agent can sign a user up for Every on their behalf. `every signup` runs one browser OAuth authorization and works without a TTY: it prints the authorization URL first (with `--json`, as the first NDJSON line `{"event":"authorization_required","url":...}`), tries to open the browser, waits on the loopback for up to `--timeout` seconds (default 300), then reports the server's `get_signup_status` envelope. It never opens the web sign-up page and never waits for Enter. `every signup complete --org-name <name> [--description <text>] [--link <url> ...] --yes` commits the profile the user confirmed through `complete_signup`, with the usual one-retry text confirmation and no `--allow-destructive`. All three bypass the tools cache; a server without the tools exits `6` with `error.code: "signup_unsupported"`. Any tool refused with `signup_incomplete` now tells the caller to run `every signup status` / `every signup complete`.

`every login --create-account` is now a deprecated alias for `every signup` (the note appears in human output only), as is the "Create an account" menu choice. Plain `every login` and `EVERY_TOKEN` are unchanged; `EVERY_TOKEN` is never a signup path.

OAuth now sends the RFC 8707 `resource` parameter (the canonical MCP resource URL from protected-resource metadata, falling back to the MCP base URL) on the authorization request, the code exchange and the refresh.

The bundled `use-every` skill carries a revision stamp (`metadata.every-skill-version`), and `every signup`/`every login` refresh installed copies whose stamp is older or missing, in the locations the installer already knows, without installing anywhere new. The skill now tells agents to run the signup flow themselves, ask one combined profile question, and never ask for passwords, codes or tokens.
