# Instrumentation log formats

Quire writes one NDJSON file per stage. Each line is a self-contained JSON
object; there is no header or footer, so any log can be tailed, truncated, or
parsed line-by-line. These are the formats the Phase 0 calibration report
(#2) reads.

All logging goes through the optional `InstrumentationSink` interface
(`src/engine/types/instrumentation.ts`). Every method on the sink is
optional, and the pipeline runs identically with no sink at all — logging is
an add-on, never a hard dependency. `createNdjsonInstrumentationSink`
(`src/engine/instrumentation/logger.ts`) is the default implementation,
writing each log type to its own NDJSON file; swap it for a different sink
without touching the pipeline.

## Gate decisions — `gate-decisions.ndjson`

One row per `(PR, criterion)` evaluated by the auto-reject gate — every
criterion not in `off` mode, not just whichever one decided the PR's final
outcome. A PR checked against three active criteria produces three rows.

```json
{"prId":"pr-123","criterionName":"buildFailure","mode":"enforce","triggered":true,"recordedAt":"2026-06-30T12:00:00.000Z"}
```

| field | meaning |
| --- | --- |
| `prId` | the PR this decision was made for |
| `criterionName` | which gate criterion ran (`buildFailure`, `outOfScope`, `duplicate`, ...) |
| `mode` | the criterion's configured mode at evaluation time (`enforce` \| `shadow`) |
| `triggered` | whether the criterion's check matched this PR |
| `recordedAt` | ISO 8601 timestamp |

`GateMode` itself has a third value, `off`, but it never appears in this log:
an `off` criterion isn't evaluated against the PR at all, so there is no
outcome to record. This is by design, not an omission — `off` criteria are
excluded upstream in `runGate`, before any `GateDecisionLog` row is built.

Phase 0 derives from this log:
- **Keep rate** — fraction of PRs with no `triggered: true` row at `mode: "enforce"`.
- **Per-criterion false-positive rate** (gate health, §12 of the engineering handoff) — for `shadow`-mode criteria, the fraction of that criterion's entries in `data/audit.json` with `overturnedAt` set, i.e. a human reviewed the audit view and confirmed the gate would have rejected a PR that didn't deserve it. `audit.json` is a mutable state file (`{ entries: AuditEntry[] }`, one entry per `(PR, criterion)` a `shadow`-mode criterion triggered on), not one of the NDJSON logs on this page — recording an overturn needs to update an existing entry in place, which NDJSON can't do, so it's persisted the same way as `data/decided-prs.json` instead (see `AuditStore`, `src/engine/gate/auditStore.ts`, and `POST /audit/:id/overturn`).

## Drift-screen results — `drift-screen.ndjson`

One row per `(bundle, member)` cheap-screen run (§6.1 of the engineering
handoff — effect-list + footprint anomaly).

```json
{"bundleId":"bundle-1","prId":"pr-123","signalCount":1,"flagged":true,"recordedAt":"2026-06-30T12:00:05.000Z"}
```

| field | meaning |
| --- | --- |
| `bundleId` | the bundle the member belongs to |
| `prId` | the member PR |
| `signalCount` | number of drift signals raised (`effectList` + `footprintAnomaly`) |
| `flagged` | `true` iff `signalCount > 0` (INV-3: never clean via agreement alone) |
| `recordedAt` | ISO 8601 timestamp |

Phase 0 derives from this log:
- **Drift base rate** — fraction of bundles with at least one `flagged: true` member.
- **Concerns-per-member distribution** — histogram of `signalCount` across all rows.

## Existing logs (unchanged)

- **`defers.ndjson`** — one row per defer gesture: `{ bundleId, deferredAt, driftFlagged }` (`DeferLog`).
- **Human findings** — written via `logHumanFinding` to a caller-supplied path: `{ bundleId, recordedAt, riderFound, riderWasFlagged, notes }` (`HumanFinding`). Pairs with `defers.ndjson` by `bundleId` to compute the silent-rider rate (Phase 2.5, §7).
