---
"@everyai/cli": patch
---

OAuth conformance with MCP spec revision 2026-07-28.

Dynamic Client Registration now declares `application_type: 'native'`. The CLI is
a native app authorizing through a loopback redirect, and saying so keeps an
OIDC-compliant server from rejecting the `http://127.0.0.1` redirect URI that web
clients are not allowed to use.

The authorization response's `iss` is now validated against the issuer found
during discovery (RFC 9207), which closes the mix-up case where a callback is
replayed from a different authorization server. A callback that omits `iss`
still completes, since not every server sends it and rejecting those would break
otherwise-valid logins.
