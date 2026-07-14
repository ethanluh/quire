# Settings: what's stubbed and why

The Settings modal (`src/interface/ui/index.html`, `mobile.html`) has ten
controls marked with a "Coming soon" or "Blocked" pill — disabled, wired to
nothing, ahead of the backend work landing. This doc is the single source of
truth for what's stubbed and why, so a stub doesn't quietly ship without
anyone tracking the follow-up. Grouped by settings page.

## Preferences

**Keyboard shortcuts.** Remap the accept/reject/defer gesture keys. No
existing Quire mechanism — a generic UX addition, not tied to any specific
architecture. Needs: a shortcut-config UI, persistence, and wiring into the
existing gesture key handlers.

**Slack notifications.** "Notify me when a bundle needs review." No existing
Quire mechanism. Needs: a notification channel (Slack webhook), a delivery
trigger tied to bundle-needs-review state, and settings storage for the
chosen channel/target.

## Team

**Require a reason to revert.** A one-line reason field on the revert
action, kept with the audit history. Revert-per-PR itself is real and
shipped (`INV-4`, `src/engine/queue/mergeQueue.ts`) — this only adds an
audit-trail requirement on top of it. Needs: a required-reason field on the
revert flow, stored alongside existing audit history.

**Export team data.** Download bundles, decisions, and audit history as
JSON. Needs: an export endpoint over that data, gated the same way other
team-scoped actions are.

**Auto-prune instrumentation logs.** Delete instrumentation NDJSON files
older than a set number of days instead of keeping them indefinitely.
Grounded in [issue #227](https://github.com/ethanluh/quire/issues/227)
("Instrumentation NDJSON files grow unbounded"). Needs: a retention-window
setting and a prune job/route.

## Pipeline

This tab covers more ground than just the auto-reject gate — bundling and
drift detection live here too, since all three are "how the pipeline
behaves" settings.

**Auto-reject gate mode selectors** (Build failure / Out of scope /
Duplicate). `GateConfig`/`GateMode` already exist and run today
(`src/engine/gate/gate.ts`, `src/engine/types/gate.ts`) — this is
config-only, no settings UI to change a criterion's mode yet. Shadow mode's
output already surfaces in the app via the audit view. Needs: per-team
`GateConfig` persistence, an API route, wiring the selects to it.

**Scope keywords** (the "Edit keywords" link on the Out of scope row).
`GateConfig.scopeKeywords` exists and is read by the `outOfScope` criterion,
but has no editor. Needs: a keywords editor UI, persistence, and a route.

**Bundle grouping sensitivity.** How similar PRs must be to land in the same
bundle. Grounded in [issue #247](https://github.com/ethanluh/quire/issues/247)
("Bundle-clustering similarity threshold (0.75) is a hardcoded guess with no
calibration behind it"). Needs: replacing the hardcoded threshold with a
per-team configurable value, and enough calibration data to pick sane preset
values for Loose/Balanced/Strict.

**Drift screening sensitivity.** Tunes the already-implemented cheap-screen
checks (`src/engine/drift/screen.ts`, footprint analyzer, symbol-coherence
check). Needs: parameterizing the cheap-screen thresholds and wiring a
per-team setting.

**Behavioral confirm.** Sandboxed differential testing for the flagged tail
— the `behavioralDelta` `DriftSignal` variant is typed but unreachable
([issue #42](https://github.com/ethanluh/quire/issues/42)), tracked as
[issue #10](https://github.com/ethanluh/quire/issues/10) ("Phase 2:
Behavioral confirm"). Unlike every other stub on this page, this one is
marked **Blocked**, not "Coming soon" — it's explicitly gated on
[issue #2](https://github.com/ethanluh/quire/issues/2) (Phase 0 calibration)
landing first, per `CLAUDE.md`'s build-phase order. Don't reword this to
"coming soon"; the distinction is deliberate.

## Known non-goals

Phase 2.5 (silent-rider measurement, [issue #11](https://github.com/ethanluh/quire/issues/11))
has no corresponding settings row. It's a measurement task, not a per-team
toggle a human sets. If that changes — e.g. it grows an on/off switch to
disable an expensive check per-team — add it here first before adding a UI
stub for it.
