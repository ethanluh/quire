# Instrumentation log formats

Each log is newline-delimited JSON (NDJSON) — one record per line — written via
`appendNdjson` (`src/engine/instrumentation/store.js`). All logs live under
`data/instrumentation/` by default and can be truncated together via `POST /admin/reset`.

Logging is optional: `orchestratePipeline` takes an `InstrumentationSink` (`src/engine/types/instrumentation.ts`)
with `recordGate`/`recordScreen` as optional methods. Omitting the sink, or providing one that
implements neither method, is a no-op — the pipeline never depends on instrumentation to run.
`NdjsonInstrumentationSink` (`src/engine/instrumentation/logger.ts`) is the default
implementation; swap in another `InstrumentationSink` to send this data elsewhere.

## `gate.ndjson` — `GateLog`

One record per PR per gate criterion actually evaluated (criteria configured `off` are not
evaluated and produce no record).

```jsonc
{ "prId": "pr-123", "criterionName": "buildFailure", "mode": "enforce", "triggered": true, "recordedAt": "2026-06-30T23:00:00.000Z" }
```

| field | meaning |
| --- | --- |
| `prId` | the PR the criterion ran against |
| `criterionName` | gate criterion name (`buildFailure`, `outOfScope`, `duplicate`, ...) |
| `mode` | `"enforce"` or `"shadow"` (the configured mode at the time of the run) |
| `triggered` | whether the criterion's check matched this PR |
| `recordedAt` | ISO 8601 timestamp |

**Keep rate**: group by `prId`, a PR is rejected if any record has `mode: "enforce"` and
`triggered: true`; keep rate is `1 - (rejected PRs / total PRs)`.

## `screen.ndjson` — `ScreenLog`

One record per PR per cheap-screen run (drift check stage 1).

```jsonc
{ "prId": "pr-123", "bundleId": "bundle-7", "signalCount": 2, "flagged": true, "recordedAt": "2026-06-30T23:00:01.000Z" }
```

| field | meaning |
| --- | --- |
| `prId` | the bundle member that was screened |
| `bundleId` | the bundle it was screened against |
| `signalCount` | number of `DriftSignal`s the screen produced (0 when clean) |
| `flagged` | `true` iff `DriftVerdict.status === "flagged"` |
| `recordedAt` | ISO 8601 timestamp |

**Drift base rate**: `flagged` records / total records. **Concerns-per-member**: distribution
of `signalCount` across records.

## `defers.ndjson` — `DeferLog`

Unchanged — one record per defer gesture, logged from `src/interface/server/routes/gestures.ts`.

```jsonc
{ "bundleId": "bundle-7", "deferredAt": "2026-06-30T23:05:00.000Z", "driftFlagged": true }
```
