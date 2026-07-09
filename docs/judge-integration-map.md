# Bundle Judge — Integration Map (Phase 0 output)

Written before any judge code exists. Purpose: pin down exactly where the judge hooks into
the existing pipeline, which files it touches, which INV-* invariants are in scope, and which
design questions are genuinely open — in the same spirit `docs/engineering-handoff.md` §10
states an assumption and proceeds rather than blocking. Nothing below is code yet.

---

## 1. The one lifecycle point

Every ingestion path — manual `/prs/ingest`, `POST /account/github/repos/select`, the
`pull_request` webhook, the `check_suite`/`pull_request_review` self-heal webhooks, and the
20-minute reconcile poll — funnels through exactly one function:

**`ingestIntoQueue()`** — `src/interface/server/ingestIntoQueue.ts:37`

It calls `orchestratePipeline()` (gate → bundle → cheap screen → spec conformance → review
card), then writes the results into `state.bundles` / `state.cards`. This is where a bundle
*becomes* triage-ready — the exact moment a `ReviewCard` exists. It is the only place the
judge needs to hook in; nothing upstream or downstream of it needs to know the judge exists.

The hook: immediately after a card is computed (not reused from `reuseReviewCard`'s cache-hit
path — see §5), and only when:

```
card.drift.status === "clean" && card.specConformance.status === "clean"
```

Both conditions gate eligibility, not just `drift`. Rationale in §3.

If ineligible, the judge is **not invoked at all** — not invoked-and-suppressed. This is
deliberately stronger than a gate that discards a verdict after computing it: an ineligible
bundle never causes an LLM call, never produces a `JudgeVerdict`, and never appears in the
judge's own audit log. "Never judge a bundle that failed drift-detection" (constraint 4) reads
as a hard boundary on when the judge *runs*, not a filter on what it's allowed to *act on*.

## 2. Files touched, by phase

| Phase | New files | Files edited |
|---|---|---|
| 1 | `docs/judge-constitution.md`, `src/engine/judge/constitution.ts`, `src/engine/judge/riskTaxonomy.ts`, `src/engine/types/judge.ts` | `.env.example` (mode/threshold vars, all inert until read) |
| 2 | `src/engine/judge/bundleJudge.ts`, `src/engine/judge/precedent.ts`, `src/interface/server/resolveJudgeProvider.ts` | `src/engine/types/judge.ts` (add `JudgeVerdict`), `.env.example` (`QUIRE_JUDGE_MODEL`) |
| 3 | `src/engine/judge/gate.ts`, `src/engine/judge/verdictPersistence.ts` | `src/interface/server/ingestIntoQueue.ts` (the hook call), `src/interface/server/tenant.ts` (construct+wire judge deps), `src/engine/types/instrumentation.ts` (optional `logJudgeVerdict`), `src/engine/instrumentation/logger.ts` (NDJSON sink impl), `docs/instrumentation.md` |
| 4 | `src/engine/judge/actionPipeline.ts`, `src/engine/judge/actionStatePersistence.ts`, `src/engine/judge/verify.ts`, `src/interface/notify/slack.ts` | `src/engine/types/instrumentation.ts` (`logJudgeAction`), `src/interface/server/routes/webhook.ts` (additive branch for verify-in-flight bundles — see §7 open question), `.env.example` (Slack/verify/CI-fix vars) |
| 5 | — | `src/engine/judge/gate.ts` (mode dispatch), `src/interface/server/tenant.ts` (audit sampling wiring), `docs/engineering-handoff.md` (new §14) |

No existing file's exported signatures change in a breaking way at any phase. Every edit to an
existing file is either (a) a new optional field/method on an already-optional interface
(`InstrumentationSink`), or (b) a new call inserted at a single point that is itself gated by
"is the judge enabled" and wrapped the same way `logSafely()` wraps instrumentation calls
today — a judge failure degrades to "no verdict," never to a broken ingest.

## 3. INV-* invariants in scope

- **INV-1 (declared vs. checked).** The judge's own verdict is *itself* another declared
  value, not ground truth — it must never bypass GATE. This is why audit sampling (§I of the
  mission, `QUIRE_JUDGE_AUDIT_SAMPLE_RATE`) exists: it is the same "never self-certify"
  discipline applied one level up, to the judge instead of to the swarm.
- **INV-2 (blind extraction).** Not directly touched — the judge never re-runs effect
  extraction; it consumes the *already-blind* `DriftVerdict` the cheap screen produced. The
  judge prompt does receive `declaredDirection` and the constitution/precedent (comparison
  targets), which is fine under INV-2 because the judge is a comparison/decision step, not an
  extraction step.
- **INV-3 (asymmetric flag/clear).** Reinforced, not just preserved: per §1, a flagged bundle
  never reaches the judge, so the judge structurally cannot be the thing that clears one.
- **INV-4 (bundle merge, PR revert).** The action pipeline's MERGE step must call
  `MergeQueue.enqueue()` (bundle-level); its HEAL-OR-REVERT step must call
  `MergeQueue.revertPr()` once per affected member (PR-level) — never a bundle-level revert
  path. No new mutation method is added to `MergeQueue`; the judge is a caller of its existing
  public API only.
- **INV-5 (accept reversible until landed).** Auto-accept in `auto` mode enqueues via the
  exact same `queue.enqueue()` a human accept uses; whether it then calls `dequeueNext()`
  immediately is gated by the same `bundleAutoMergeEnabled()` per-repo opt-in gestures.ts
  already checks — the judge does not get a separate, more aggressive auto-merge trigger than
  a human accepting the same bundle would.
- **INV-6 (honest residual).** Every verdict and every autonomous action is persisted
  (append-only) and, in `auto` mode, produces a Slack notification on every terminal outcome.
  A judge that ran and decided nothing is worse than one that discloses it decided nothing.

## 4. Existing patterns the judge must follow, not reinvent

- **LLM access**: through `LlmProvider` (`src/engine/drift/effectList/provider.ts`), never a
  direct fetch. `resolveJudgeProvider.ts` mirrors `resolveLlmProvider.ts` exactly — same
  precedence rules, same "unset → stub, with a warning" fallback shape — but reads
  `QUIRE_JUDGE_MODEL`/a separate judge account instead. Falls back to the tenant's already-
  resolved provider (bias-mitigation-off, logged) rather than failing closed, matching
  `resolveDefaultLlmProvider`'s "always resolves to *something*, worst case the stub" contract.
- **Structured output validation**: `zod` is already a dependency (`GestureSchema` in
  `gestures.ts`). `JudgeVerdict` parsing uses a zod schema, and — mirroring
  `semanticHunkResolver.ts`'s retry-with-feedback loop — malformed output gets fed back to the
  model for a bounded number of retries before failing to a typed "abstain" verdict, never a
  thrown exception that could take down `ingestIntoQueue()`.
- **Side-effecting concurrency**: `MergeQueue` already serializes every mutation through one
  `withLock()` chain (mergeQueue.ts) specifically because independent triggers (human click,
  `autoMergeOnAccept`, webhooks) don't coordinate with each other. The judge's action pipeline
  adds a **second, judge-scoped** keyed lock (reusing `createKeyedLock`, keyed by `bundleId`)
  around its own state-machine transitions, but every merge/revert it actually performs still
  goes through `MergeQueue`'s own lock via its existing public methods — two locks, one
  authoritative mutator.
- **Idempotency**: same shape as `recordExternalMerge`'s "already in mergedPrIds → no-op."
  Every action-pipeline step re-reads its own persisted `JudgeActionState` before acting and
  no-ops if already in or past that state — a replayed webhook or a re-entrant poll can call
  the pipeline twice for the same bundle without double-merging or double-reverting.
- **Persistence**: per-team, under `data/teams/<teamId>/`, via `createJsonStatePersistence`
  (validate-on-read, atomic write, migrate-on-load) — `judge-verdicts.json` and
  `judge-actions.json` — plus append-only NDJSON audit trails under
  `data/teams/<teamId>/instrumentation/` (`judge-decisions.ndjson`, `judge-actions.ndjson`),
  matching `defers.ndjson`/`gate-decisions.ndjson`/`drift-screen.ndjson` exactly.
- **Graceful degradation when unconfigured**: no judge LLM account/model, no Slack webhook →
  the corresponding module no-ops and logs a warning once, exactly like `resolveLlmProvider`
  falling back to `StubLlmProvider` and the webhook receiver simply not mounting when
  `QUIRE_PUBLIC_URL`/`GITHUB_APP_WEBHOOK_SECRET` are unset. Never a startup crash, never a
  thrown error on the hot path.

## 5. Precedent retrieval — data source

No new store is needed. Nearest-past-human-gesture precedent already lives in two existing
files per team:

- `data/teams/<teamId>/queue.json` — `MergeQueueEntry` rows with `status: "landed"` (accepted
  and merged), `"closed"` (rejected, or a member closed without merging), or `"reverted"`
  (accepted, merged, then undone) — each carries the *full* `Bundle` and `ReviewCard`.
- `data/teams/<teamId>/shelf.json` — `ShelfEntry` rows for every currently-deferred bundle,
  same full `card`/`bundle` shape.

`precedent.ts` reads both, filters to terminal/shelved entries, and ranks by similarity against
the candidate bundle's `effectSummary` (reusing whatever comparison primitive
`similarity.ts`/`clusterClassifier.ts` already expose, rather than a new one). This doubles as
the eval set the mission asks for (§C) — it requires no new instrumentation to exist.

## 6. Cache-hit / re-ingestion idempotency

`orchestratePipeline()` already reuses a prior card (`reuseReviewCard`) when
`computeInputsHash(bundle)` is unchanged, to skip re-screening. The judge must respect the same
fingerprint: before invoking the judge, check whether `judge-verdicts.json` already has an
entry for `(bundleId, inputsHash)`. If so, skip — this is what stops a bundle sitting untouched
in the review queue from being re-judged (and, in `auto` mode, re-actioned-on) every time the
20-minute reconcile poll or a webhook re-triggers `refreshRepoQueue()` for its repo.

## 7. Open decisions (state the assumption, proceed, flag it — per handoff-doc §10 style)

- **`QUIRE_JUDGE_MODE` literal set.** The mission text lists three values
  (`shadow | assist | auto`, default `shadow`) but constraint 2 says the judge "defaults to
  shadow / OFF," conflating two different things. Assumption: add a fourth literal, `"off"`,
  as an explicit kill switch distinct from `"shadow"` (which still runs and logs) — default
  remains `"shadow"`. Proceeding on this; flag if a true "does nothing at all, not even log"
  mode is wanted more strongly than shadow-logging.
- **VERIFY step is read-only — resolved, not open.** Quire never executes commands. Confirmed
  design:
  - **Core signal**: GitHub's own CI on the merge commit, via the existing `check_suite`
    webhook. `mergePullRequest()` currently returns `Promise<void>` — widen it to return the
    merge-commit SHA (`OctokitGitHubClient` and `StubGitHubClient` both updated in the same PR,
    covered by `mergeQueue.test.ts`/`octokitClient.test.ts`), and match incoming `check_suite`
    events by `(repoOwner, repoName, head_sha)` against a small "awaiting judge verification"
    set — additively, alongside the existing PR-id-keyed `reattemptForPr` branch, never
    replacing it.
  - **Optional deploy signal**: a single post-deploy HTTP GET against
    `QUIRE_JUDGE_HEALTHCHECK_URL`, with brief retries to absorb deploy lag. No-op cleanly when
    unset. No Fly API integration — a plain GET, mirroring the existing "unconfigured →
    no-op + log" shape everywhere else.
  - **`QUIRE_JUDGE_VERIFY_COMMAND` / local shell execution is explicitly out of scope** — not
    built, not flag-gated-off, removed from the plan and `.env.example` entirely. Quire stays
    100% GitHub/LLM API calls; local test execution lives in GitHub CI, which is exactly what
    the check_suite signal above reads.
  - **Outcome rules**: CI green (and health OK if configured) → Slack success. CI failure, or
    an explicit unhealthy/5xx health response → auto-revert via `MergeQueue.revertPr()` (per
    member, INV-4) → Slack escalation. No CI result within the timeout window, or health check
    unreachable/timeout → **inconclusive**: never declare success, never auto-revert — escalate
    to a human via Slack. Absence of a failure is never treated as proof of success, and a
    network blip must never trigger a revert.
  - All merge/revert continues to go exclusively through `MergeQueue`'s existing public methods
    (`enqueue`/`dequeueNext`/`revertPr`) — no new mutation path.
- **Judge-vs-human agreement metric.** The mission (§I) wants this "alongside the handoff
  doc's success metrics." Assumption: a derived stat computed from
  `judge-verdicts.json` × `decided-prs.json` (join on `bundleId`/`prId`), surfaced via a new
  read-only `GET /admin` or `/audit` sub-route reusing `adminRouter`'s existing pattern, not a
  new persisted "metrics" file — it's always recomputable from the two logs, so nothing new
  needs to be kept in sync.

## 8. What Phase 1 will NOT touch

Confirming before writing any code: Phase 1 is `docs/judge-constitution.md` +
`src/engine/judge/constitution.ts` (typed loader) + `src/engine/judge/riskTaxonomy.ts` (pure
matching function) + their unit tests. It does not call an LLM, does not touch
`ingestIntoQueue.ts`, `tenant.ts`, or any GitHub/Slack integration, and does not change any
existing file's behavior. `npm run build && npm test && npm run lint` must stay green with a
diff that is purely additive.
