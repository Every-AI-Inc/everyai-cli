# CLI evaluations

The offline cold-start contract runs through real CLI subprocesses with a mock transport: `every docs`, `every whoami --json`, then `every invoice create --party "Brandon Chu" --operation-id <uuid> --amount 100 --yes --json`. The budget is at most five CLI invocations; ordinary server confirmation stays within the create invocation and reuses the exact operation and typed target.

Run `npm test -- tests/eval-cold-start.test.ts` for typed resolution, mixed same-name/same-UUID identities, secondary-email queries, complete-page requirements, and no tool call before local write permission. `tests/cli.test.ts` retains trusted-confirmation, timeout, human-approval and policy regressions. Mock transport proves client behavior, not server/database compatibility.

`tools-alias-schemas.json` is generated from the candidate backend's actual registered FastMCP tools. The v1 historical fixture is retained solely for stale-catalog regressions, never used as a write fallback. The installed skill and plugin metadata are included in the package validation suite.

Actual CLI → FastMCP → signed PostgREST → isolated PostgreSQL evaluation is separately recorded in the branch handoff. Shared staging/prod tests and npm publication remain release steps after the backend is live. Never use real customer data for local write tests.

The live cold-start evaluation is `people-companies-cold-start-model.py claude|openai`.
Run it with the API worktree's Python and the same `PC_API_WORKTREE`,
`PC_SCHEMA_DSN`, and `PC_POSTGRES_BIN` settings as `people-companies-protocol.py`.
It gives the model the planned `every docs --json` starting command and at most
five compiled CLI invocations. A real secondary-email lookup, typed invoice,
stable operation ID, ordinary confirmation retry and absence of a synthetic
Company are checked against the local database. The model chooses subsequent
commands; this is separate from the scripted mock cold-start tests.

OAuth identity is injected through an isolated userinfo cache. The real settings
handler reads captured org column definitions in the disposable fixture; it does
not contact shared services. Only provider keys/model selectors are read from the
private API env for the selected live model. Logs identify the model, binary hash,
actual commands, database outcome and cleanup; no token is printed.
