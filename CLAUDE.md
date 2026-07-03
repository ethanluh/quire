# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Quire is a triage tool for pull requests produced by a fleet of coding agents (a swarm). It groups PRs that pursue the same product direction into a **bundle**, so a human makes one directional decision per bundle instead of one per PR. The human accepts, defers, or rejects a bundle with a single gesture. Quire does **not** verify code correctness — that is assumed handled upstream.

## Pull request discipline

Whenever a PR addresses a GitHub issue, link the issue in the PR body using a closing keyword so GitHub closes it automatically on merge (e.g. `Closes #<number>`, `Fixes #<number>`, or `Resolves #<number>`). Never open a PR that addresses a tracked issue without this link.

Every PR body must also include a `<!-- declared-direction: ... -->` HTML comment stating the PR's product-direction intent in one sentence, e.g. `<!-- declared-direction: Add dark mode toggle to settings panel -->`. This is Quire's own ingestion requirement, not just a convention: `OctokitGitHubClient` (`src/engine/github/octokitClient.ts`) reads real PRs through exactly this marker to populate `declaredDirection` (INV-1 — the label must be explicit, never inferred from the diff), and a PR missing it is silently skipped from ingestion rather than failing loudly. When dogfooding Quire against its own repo (see "Running and testing locally" below), a forgotten marker means the PR just never shows up in the queue.

## Running and testing locally

- **Setup**: `npm install`.
- **Dev server**: `npm run dev` (runs `tsx src/interface/server/index.ts`). Serves the UI and API at `http://localhost:3000` (override with `PORT`). There's no database — state persists to the gitignored `data/` directory, one subdirectory per signed-in GitHub login (`data/users/<login>/{queue.json,installation.json,llm-account.json,decided-prs.json,pr-cache.json,instrumentation/*.ndjson}`), created automatically on that login's first request.
- **GitHub auth is a GitHub App, not a personal token.** Register one (see `.env.example`'s `GITHUB_APP_*` vars and this file's "GitHub App setup" pointer once written) and set the resulting env vars — without them the server refuses to start. Sign-in uses the App's own OAuth (identity only); actual API access comes from an installation bound via Settings' (gear icon in the header) "Install GitHub App" button. There is no more `GITHUB_TOKEN`/PAT fallback and no `StubGitHubClient`-backed demo login — the app requires a real (even if locally-scoped) GitHub App to sign in at all.
- **Multi-tenant by GitHub login.** Every signed-in, allowlisted login gets its own fully isolated `TenantContext` (`src/interface/server/tenant.ts`) — its own GitHub App installation/repo selection, PR queue, decided-PR record, LLM account, and in-memory review state. `TenantRegistry` creates these lazily per login (never a new identity scheme — the session's verified `login` *is* the tenant key) and hydrates every existing one from disk at startup so webhooks/reconciliation work for logins that aren't actively browsing. Nothing downstream of `requireSession` may read or write state shared across logins — that was the root cause of a prior cross-account bleed bug where one teammate's GitHub App connection silently overwrote another's.
- **Access control**: every route except the two login-establishing ones (`/account/github/oauth/start`, `/account/github/oauth/callback`) and the HMAC-verified webhook route requires a signed session cookie (`middleware/requireSession.ts`), gated by `QUIRE_ALLOWED_GITHUB_LOGINS`. This replaces the old localhost-only/`X-Quire-Admin`-header model — Quire is designed to be reachable off the box it runs on now.
- **Dogfooding on the Quire repo itself**: open `http://localhost:3000`, sign in with GitHub, install the GitHub App on your account/org from Settings (gear icon in the header), then select `quire` from the repo list. Selecting a repo immediately fetches its open PRs and ingests them into the queue. Its own PRs must carry the `<!-- declared-direction: ... -->` marker (see "Pull request discipline" above) or they're silently skipped.
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
