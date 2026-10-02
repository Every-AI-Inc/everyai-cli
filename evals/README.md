# CLI DX Evals

## Cold-Start Signup Round Trips

Metric: CLI invocations a skill-equipped agent needs for "sign me up for Every"
with no TTY and no existing account.

- Before `every signup`: impossible for an agent (`login --create-account`
  needed an interactive terminal and an Enter keypress).
- Expected mock path: exactly 2 invocations, `every signup --json` and
  `every signup complete --org-name "<name>" --yes --json`, with one browser
  step for the human between them. The complete call may make one internal
  text-confirmation retry without costing another invocation.
- The same eval proves another tool is refused with `signup_incomplete` before
  completion and allowed after it.

```bash
npm test -- tests/eval-cold-start.test.ts
```

Live staging check (after the server ships the signup tools): run
`every signup --staging --json`, finish the browser step, then
`every signup complete --staging --org-name "<name>" --yes --json`.

## Cold-Start Invoice Round Trips

Metric: total CLI invocations needed for a skill-equipped agent to handle
"invoice client Brandon Chu for $100" from a cold start.

- v0.1.0 trace: 13 invocations.
- Current CI budget: <= 5 invocations.
- Expected mock path: exactly 3 invocations. The create invocation may make one
  internal text-confirmation retry, but it must not cost the agent another CLI
  round trip.

CI runs the offline mock version on every push through `npm test`:

```bash
npm test -- tests/eval-cold-start.test.ts
```

Manual live staging check:

```bash
every docs
every whoami --staging --json
every invoice create --staging --client "Brandon Chu" --amount 100 --yes --json
```

Use `EVERY_EVAL_LIVE=1` only as a local operator signal for live eval runs; the
checked-in test remains offline and mock-only.
