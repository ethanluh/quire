# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Quire is a triage tool for pull requests produced by a fleet of coding agents (a swarm). It groups PRs that pursue the same product direction into a **bundle**, so a human makes one directional decision per bundle instead of one per PR. The human accepts, defers, or rejects a bundle with a single gesture. Quire does **not** verify code correctness — that is assumed handled upstream.

## Pull request discipline

Whenever a PR addresses a GitHub issue, link the issue in the PR body using a closing keyword so GitHub closes it automatically on merge (e.g. `Closes #<number>`, `Fixes #<number>`, or `Resolves #<number>`). Never open a PR that addresses a tracked issue without this link.

Every PR body must also include a `<!-- declared-direction: ... -->` HTML comment stating the PR's product-direction intent in one sentence, e.g. `<!-- declared-direction: Add dark mode toggle to settings panel -->`. This is Quire's own ingestion requirement, not just a convention: `OctokitGitHubClient` (`src/engine/github/octokitClient.ts`) reads real PRs through exactly this marker to populate `declaredDirection` (INV-1 — the label must be explicit, never inferred from the diff), and a PR missing it is silently skipped from ingestion rather than failing loudly. When dogfooding Quire against its own repo (see "Running and testing locally" below), a forgotten marker means the PR just never shows up in the queue.

## Running and testing locally

- **Setup**: `npm install`.
- **Dev server**: `npm run dev` (runs `tsx src/interface/server/index.ts`). Serves the UI and API at `http://localhost:3000` (override with `PORT`). There's no database — state persists to the gitignored `data/` directory (`queue.json`, `github-account.json`, `instrumentation/*.ndjson`), created automatically on first run.
- **GitHub auth**, in priority order: a connected account (set up through the UI, persisted to `data/github-account.json`) beats the `GITHUB_TOKEN` env var beats the built-in `StubGitHubClient` (mock data, no token needed — fine for exercising pipeline logic, but doesn't ingest real PRs).
- **Dogfooding on the Quire repo itself**: open `http://localhost:3000`, use the account panel to connect a GitHub PAT with `repo` scope, then select `quire` from the repo list. Selecting a repo immediately fetches its open PRs and ingests them into the queue. Its own PRs must carry the `<!-- declared-direction: ... -->` marker (see "Pull request discipline" above) or they're silently skipped. Note the account/repo-selection endpoints are gated to localhost and require a same-origin header — they're only reachable through Quire's own UI, not arbitrary scripts.
- **Automated tests**: `npm test` (Jest via `ts-jest`, ESM), `npm run build` (`tsc`), `npm run lint` (`tsc --noEmit`).

## Code style

- TypeScript strict mode throughout.
- Tabs for indentation.
- Named exports only (no default exports).
- `interface` for object shapes; `type` for unions and aliases.
- No `any`.

## Architecture

The pipeline runs top to bottom:

1. **Ingest** — consume swarm PRs, each carrying a `declaredDirection` string supplied by the author agent. This field is a cheap prior and is **never** used as a verdict (INV-1).
2. **Auto-reject gate** — per-criterion, three modes each: `enforce` (discard), `shadow` (route to audit view), `off` (pass to human queue). Criteria do not share a confidence level.
3. **Bundle by direction** — group surviving PRs by directional similarity. A PR joins a bundle on evidence from the drift check, never on topic resemblance alone.
4. **Drift check** — two stages:
   - *Cheap screen* (every member): effect-list extraction run **blind** to `declaredDirection` (INV-2), then matched against the bundle direction; plus footprint anomaly via static analysis. Tuned for high recall — over-flags on purpose.
   - *Confirm* (flagged tail only): sandboxed behavioral differential testing with intent-classification (Testora approach). Expensive; rationed to the flagged tail.
5. **Review card** — per bundle: direction summary, blast radius, flags (public API / migration / shared module), drift verdict.
6. **Gestures** — right = accept (enqueue), left = reject, down = defer.
7. **Merge queue** — lands accepted bundles as one transaction; revert operates at individual PR granularity (INV-4, INV-5).

### Key invariants (never violate these)

- **INV-1** — `declaredDirection` is the label, not the verdict. Never trust it directly.
- **INV-2** — effect-list extraction runs without seeing `declaredDirection`. Feed the declaration only as a comparison target *after* extraction.
- **INV-3** — declaration-level disagreement may flag a member; agreement may never clear one. Clearing requires the independent check.
- **INV-4** — accept operates on bundles; revert operates on individual PRs.
- **INV-5** — accept enqueues; it does not merge synchronously. Every accept is reversible until the merge queue lands it. *Exception: an explicit, opt-in `autoMergeOnAccept` account setting drains the queue immediately on accept for users who want that; default is off.*
- **INV-6** — surface what the system could not clear. Disclose the residual honestly on the card.

### Module boundaries

- **Orchestration / services** — TypeScript, lives in `src/`.
- **LLM-backed steps** (effect-list extraction, intent classification) — behind a thin provider interface so they are swappable and testable.
- **Static analyzers** (footprint/symbol resolution) — behind a pluggable analyzer interface, one implementation per target language. The orchestration layer is language-agnostic.

### Core data model (starting points, not frozen contracts)

```typescript
interface PullRequest {
	id: string;
	declaredDirection: string;
	diff: Diff;
	filesTouched: ReadonlyArray<string>;
	symbolsTouched: ReadonlyArray<SymbolRef>;
}

interface Bundle {
	id: string;
	direction: string;
	members: ReadonlyArray<PullRequest>;
}

interface Effect {
	clause: string;
	matchedDirection: boolean; // set only after comparison, never during extraction
}

type DriftSignal =
	| { kind: "effectList"; orphanClauses: ReadonlyArray<string> }
	| { kind: "footprintAnomaly"; surprisingSymbols: ReadonlyArray<SymbolRef> }
	| { kind: "behavioralDelta"; description: string; classified: "intended" | "unintended" };

type DriftVerdict =
	| { status: "clean" }
	| { status: "flagged"; signals: ReadonlyArray<DriftSignal> };

interface ReviewCard {
	bundleId: string;
	directionSummary: string;
	blastRadius: number;
	flags: ReadonlyArray<string>;
	drift: DriftVerdict;
}

type GestureAction = "accept" | "defer" | "reject";
```

## Build phases

Phase order is load-bearing — do not reorder.

- **Phase 0** — calibration (measure keep rate, drift base rate, concerns-per-member before writing detectors). Output is a report, not code.
- **Phase 1** — MVP: ingest → gate → bundle → cheap screen → review card → gestures → merge queue. Behavioral confirm is explicitly out of scope; the card discloses this.
- **Phase 2** — behavioral confirm on flagged tail (gated on Phase 0 showing material drift).
- **Phase 2.5** — measure the silent-rider hole on passed members. Forks: negligible → ship; material → Phase 3.
- **Phase 3** — directed/search-based test generation (conditional on Phase 2.5).
