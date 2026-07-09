# CLI DX Evals

## Cold-Start Invoice Round Trips

Metric: total CLI invocations needed for a skill-equipped agent to handle
"invoice client Brandon Chu for $100" from a cold start.

- v0.1.0 trace: 13 invocations.
- Current CI budget: <= 5 invocations.
- Expected mock path: exactly 3 invocations.

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
