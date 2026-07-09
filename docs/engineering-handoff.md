# Engineering Handoff — Quire

Quire — direction-triage for swarm PRs. The name is a real (archaic) word: a quire is a gathered set of leaves bound together, which is exactly the unit this product operates on — a bundle of PRs gathered by shared direction. Note for written/spoken use: it is a homophone of "choir," so favor the written form (repo, package, CLI, URL) where the spelling disambiguates.

This document is the build spec for an agent-facing engineer (Claude Code). It is written to be executed in phases with hard gates between them. Read §1–§4 before writing any code — they contain invariants that, if violated, produce a product that is fast but untrustworthy, which is worse than shipping nothing. The phase order in §8 is deliberate and load-bearing; do not reorder it to build the "interesting" parts first.

---

## 1. What this is

Quire is a triage tool for pull requests produced by a fleet of coding agents (a swarm). The swarm generates a high volume of PRs — on the order of dozens per hour — most of which are individually correct. The scarce resource is **not** code review for correctness. It is the rate at which a human can decide the **high-level product direction** that a feature takes the product.

The keep rate is high — around 60% in the case that motivated this product (roughly 50 PRs generated per hour, ~30 mergeable). That number is load-bearing in two ways. First, it justifies the product's existence: at a low keep rate (say 6%) the right fix is upstream — better task decomposition, fewer redundant agents — because the cheapest PR to review is the one never opened; at 60% the swarm is producing genuinely good work faster than humans can absorb it, and a triage tool is warranted. Second, it reshapes the pipeline: a high keep rate means the auto-reject gate (§4) culls only a small mechanically-dead minority, and almost everything flows through to the drift check and the human, so that is where engineering effort and human attention actually go — not the gate.

Quire buys back that human time by grouping PRs that pursue the same product direction into a **bundle**, so the human makes one directional decision per bundle instead of one decision per PR. The human accepts, defers, or rejects a bundle with a single gesture.

The product's entire value proposition rests on one bargain: the human stops checking correctness and checks only direction. That bargain is only safe to the exact degree that the bundle's stated direction is an honest description of what every PR in it actually does. Guarding that honesty is the hard center of the system (§6).

---

## 2. The problem it does not solve (non-goals)

State these explicitly so scope does not creep:

- Quire does **not** verify code correctness. Correctness is assumed handled upstream by the generation pipeline (tests, CI, the agents' own loops). If that assumption is false for a given user, Quire is the wrong tool and should say so rather than silently absorbing the role.
- Quire is **not** a code-review UI in the line-comment sense. It is a directional adjudication surface. A reviewer who wants to read 800 lines of diff has defeated the purpose.
- Quire does **not** decide *whether* a bundle deserves scrutiny on the human's behalf. It surfaces signal; the human's gesture is the router (see §3 invariant, and §5 the defer gesture).
- The merge unit is the bundle; the revert unit is the single PR. Quire must never make a bundle-level action that cannot be undone at PR granularity.

---

## 3. Design invariants

These are non-negotiable. Every verification component in the system is an instance of the same pattern, and the pattern is the reason the product can be trusted. If a proposed change violates one of these, stop and flag it rather than implementing it.

**INV-1 — Declared vs. checked.** Every verdict compares a *declared* value (a cheap prior supplied by the author agent — the PR's stated direction, its claimed concerns) against an *actual* value derived from a source independent of the author (the diff, the observed behavior). The declaration is the label; it is never the verdict. Trusting the declaration directly is self-certification and is forbidden — the agent that wrote the change cannot witness its own change, exactly as it cannot certify its own correctness.

**INV-2 — Blind extraction.** Any model that extracts what a PR *actually does* (the effect-list, §6.1) runs **without** seeing the declaration. Feeding the declaration into the extractor biases it toward confirming the claim. The declaration is supplied only as the comparison target, after extraction, never as context during extraction.

**INV-3 — Asymmetric flag/clear.** Declaration-level *disagreement* may flag a member for closer inspection. Declaration-level *agreement* may never clear a member. Agreement is precisely where undeclared behavior hides (the agent sincerely believes it stayed on-direction, and said so). Clearing requires the independent check, not the matching label.

**INV-4 — Bundle merge, PR revert.** Acceptance operates on bundles; reversion operates on individual PRs. A merge queue (§4) is mandatory infrastructure, not an optimization, because it is what decouples accept-granularity from revert-granularity.

**INV-5 — Accept is reversible until it lands.** The accept gesture enqueues; it does not merge synchronously. Until the merge queue lands a bundle, an accept is as reversible as a reject. This is what makes fast gestural triage rational — every gesture must be cheap and reversible.

**INV-6 — Honest residual.** Quire ships with a known, measured, disclosed detection limitation (§7). It surfaces what it could not clear. A product whose holes are named and bounded is more trustworthy than one whose holes are hoped-absent. Apply to Quire the same standard Quire applies to the swarm: declare the limitation, measure its size, surface what cannot be cleared.

---

## 4. System architecture

The pipeline, top to bottom:

1. **Ingest.** Consume swarm PRs. Each PR arrives with a *declared direction* (the agent's stated product intent for the change) as structured metadata. If the swarm does not yet emit this, that capture is a prerequisite — see Open Decisions §10. Capturing direction at generation time is vastly cheaper and more faithful than reconstructing it from diffs afterward.

2. **Auto-reject gate.** Cull mechanically dead PRs (fails build, fails tests, out of declared scope, duplicate of another open PR). This is a **per-criterion user setting**, not one master switch — the criteria do not share a confidence level (a build failure is deterministic; an out-of-scope judgment is not). Each criterion has three modes: `enforce` (discard), `shadow` (run, but route what it would have rejected to an audit view instead of discarding, so the user can verify the gate's precision before trusting it), and `off` (route to the human queue, never auto-accept). At the observed ~60% keep rate (§1) this gate removes only the small mechanically-dead minority; most PRs flow past it to the drift check and the human. Do not over-invest in it.

3. **Bundle by direction.** Group surviving PRs by **directional similarity** — PRs that mean the same thing about the product. Note carefully: this is **not** coupling. Coupling (does PR A's correctness depend on PR B?) was an earlier candidate and is demoted. Coupling does not *form* bundles; it only governs how a bundle *lands* (the merge queue must not leave a bundle in a broken intermediate state). Two mechanically independent PRs can share a direction; two tightly coupled PRs can embody two distinct directional bets.

   A PR that appears to "fit" an existing bundle's direction is **not** a special case with its own subsystem. It is a candidate member run through the same membership and drift check every declared member already passes — it joins on evidence (it actually shares the direction, confirmed by the drift check), never on topic resemblance alone. "Fits the category" should trigger the check, not the grouping decision; a PR that merely shares a theme but diverges on the check is a neighbor shown alongside, not a member, and never inherits the bundle's merge transaction.

4. **Drift check.** The trust engine. Two stages — cheap screen on every member, expensive confirm on the flagged tail only. Detailed in §6.

5. **Review card.** Per bundle: an honest direction summary, blast radius, explicit flags (touches public API / migration / shared module), and a drift indicator that distinguishes "system caught divergence" from "clean but weighty."

6. **Gestures.** Right = accept (enqueue), left = reject, down = defer. See §5.

7. **Merge queue.** Lands accepted bundles as one transaction, with per-PR revert machinery behind it (INV-4, INV-5).

Suggested implementation shape: orchestration and services in TypeScript (strict mode), following the repo `CLAUDE.md` (tabs, named exports, `interface` for shapes, `type` for unions, no `any`). Language-specific static analyzers (footprint/symbol resolution, §6.1) live behind a pluggable analyzer interface because that layer is per-language and is an open decision (§10). LLM-backed steps (effect-list extraction, intent classification) call the model behind a thin provider interface so they are swappable and testable.

---

## 5. The gestures

Three actions, mapped to three swipes:

- **Right → accept.** Enqueues the bundle to the merge queue (INV-5). Reversible until landed.
- **Left → reject.** Cheap, reversible. The swarm regenerates; false rejects cost nothing visible.
- **Down → defer.** Shelves the bundle for a closer look later, without breaking triage rhythm. The animation should drop the card into a visible shelf tray so the spatial result teaches the meaning.

Defer is a discretionary *human scrutiny dial* that rides on top of an already-honest card. It is **not** a substitute for the drift check, and the system must never auto-route a bundle to the shelf based on a property of the diff — that would relocate the "is this worth scrutiny?" decision from the human (who knows intent) to a detector (which sees only the diff). The card surfaces depth signals loudly; the gesture remains the human's verdict.

When the drift check flags divergence, the card's drift indicator says so explicitly, so a deferred card carries *why* it might warrant a closer look (system-flagged drift vs. human-chosen caution). Do not conflate those two reasons under one undifferentiated indicator.

---

## 6. The drift check (the heart)

The failure this guards against is **direction drift**: a bundle whose summary promises one direction while a member quietly does something else. The dangerous, common case is the **rider** — a PR that goes the right direction *and also* does one undeclared thing (advances passwordless auth, *and* silently adds login rate-limiting). The code is correct; the direction is undeclared. A one-line summary is structurally blind to a rider because the rider lives in the tail the summary drops.

A rider is, in the software-engineering literature, a *tangled change* — a single change carrying more than one concern. Three bodies of prior art inform the design (references in §11). Reframe the per-member question accordingly: not "is this member aligned with the bundle direction?" (binary) but "how many distinct concerns does this member contain?" (multi-label). A clean member is one concern, on-direction; a rider is two — one on-direction plus an orphan.

Two stages with **opposite blind spots**, so each covers the other:

### 6.1 Cheap screen — runs on every member

Two cheap signals:

- **Effect-list vs. declaration.** A small model enumerates every product-level effect of the diff (usually one to three clauses), generated **blind** to the declaration (INV-2), then each effect is matched against the bundle's declared direction. Gross drift shows up as a member with no matching effect; rider drift shows up as an orphan clause with no directional home. Prefer an *effect list*, not a one-line summary — the one-liner reports the main thrust and eats the rider.
- **Footprint anomaly.** Deterministic static analysis of files/symbols touched. Useless as a *direction* signal (diverse-but-aligned PRs touch disjoint code and mean the same thing), but valuable as an *anomaly* signal: a member reaching into symbols outside the bundle's expected territory is structurally surprising, which is the signature of many riders. High-recall, low-precision — which is correct for a screen, because a confirm stage follows.

Tune the screen to **over-flag** on purpose. Its job is high recall; precision is the confirm stage's job. A near-free stage-zero check (member's declared intent vs. bundle declared direction) may *flag* but, per INV-3, may never *clear*.

Test names changed by the diff may be fed **into** the effect-list extractor as one input — a test named for the behavior it asserts is compressed intent and a genuine signal. They must never be used as a standalone detector or as grounds to clear a member: tests are author-written and carry the same self-certification leak as the declaration (INV-1), and coverage is patchy (refactors and config changes move direction with no test delta). Same status as the declaration — claimed, not trusted.

### 6.2 Confirm — runs on the flagged tail only

Behavioral differential testing with intent-classification (the "Testora" approach, §11). For a flagged member: generate tests that exercise the modified code, differential-test old vs. new behavior, then classify each observed behavioral difference against the declared direction as *intended* or *unintended*. This is the executable witness that catches the structurally-local, semantically-plausible rider that fools both text signals — because when you *run* it, the undeclared effect produces a measurable behavioral delta with no declared home, even when reading the diff would rationalize it as in-direction.

This stage requires a sandboxed execution environment and is the expensive part of the build. It is rationed: you ration the *reasoning and execution*, not the *reading*. The cheap screen *reads* every member, and at this volume that is affordable — roughly 50 PRs generated per hour means reading every surviving member is on the order of tens of cheap reads per hour, not a bottleneck. What is expensive is generating tests, executing them, and reasoning about behavioral deltas; running that only on the flagged tail keeps cost proportional to the drift rate, not the PR volume. The cost objection that this stage seems to raise is mostly a phantom once you separate cheap reading from expensive reasoning.

---

## 7. The known residual

The confirm stage catches a rider only if generated tests *reach* it and it *manifests* as an observable difference. A behaviorally-silent rider, or one in an uncovered path, still slips. So the residual is the intersection of three conditions: semantically plausible **and** structurally local **and** behaviorally silent under generated tests. This is a fourth nine after three nines are covered, not "the product doesn't work."

Per INV-6, the residual is to be **measured before it is engineered against**, and disclosed on the card until closed. The trap to avoid: pushing test-generation coverage aggressively to chase the silent rider introduces its own false-positive rate, surfacing real-but-immaterial behavioral differences, which trains the human to distrust the drift indicator (the specificity failure). A false positive degrades trust on every bundle; a rare silent miss degrades it only on bundles that contain one. Do not trade the first away to buy down the second without data.

---

## 8. Phases

The gates between phases are the point. Do not skip Phase 0. Do not build Phase 3 before Phase 2.5 produces a number that justifies it.

### Phase 0 — Calibration (days, not weeks; before building detectors)

Manually audit a representative sample of real swarm bundles. Establish baselines:

- Keep rate (fraction of generated PRs that are mergeable).
- **Drift base rate** — fraction of bundles that contain at least one rider, measured by human audit, independent of any detector.
- Distribution of concerns per member (validates the multi-label framing and the "≤3 concerns" assumption).

**Exit gate:** a go/no-go on the drift-detection investment and concrete target metrics. If the drift base rate is negligible, the cheap screen alone may suffice and Phase 2 may be deferred indefinitely. Output is a short calibration report, not code.

### Phase 1 — MVP

The core triage loop that delivers value immediately, with the cheap screen as the only drift detection and the residual disclosed honestly.

In scope:
- Ingest swarm PRs + declared-direction metadata.
- Auto-reject gate, per-criterion, with `enforce`/`shadow`/`off` modes.
- Bundle by directional similarity.
- Cheap drift screen (§6.1): effect-list (blind) + footprint anomaly, producing a drift flag.
- Review card: direction summary, blast radius, flags, drift indicator.
- Three-gesture interface (right enqueue, left reject, down defer) with the shelf tray.
- Merge queue: bundle merge, per-PR revert.
- **Instrumentation:** log every defer and the human's eventual finding — did they find a rider, and had it been flagged? This is the data that feeds Phase 2.5; building it now is cheap and building it later means starting the measurement clock late.

Explicitly **out** of MVP scope: behavioral confirm, directed test generation. The MVP card discloses: "behavioral check not yet active; rare undeclared changes may not be caught." Honesty over coverage.

**Exit gate:** the loop is usable end to end on real swarm output; the core gestures and merge queue are reliable; instrumentation is capturing defer outcomes. Trust comes first from a clean core loop, not from exotic detection.

### Phase 2 — Behavioral confirm

Gated on Phase 0 showing a material drift base rate.

Add the §6.2 confirm on the flagged tail: sandboxed execution environment, LLM-based test generation over modified code, differential comparison against the base, intent-classification of each behavioral delta. Use a chain-of-thought confirm prompt tuned for specificity (it trades recall for precision/specificity — appropriate when the cheap screen already supplied recall).

**Exit gate:** confirm runs reliably on the flagged tail within cost budget; flag rate on the card stays low enough that the indicator remains believed.

### Phase 2.5 — Size the silent-rider hole

With screen + confirm live, run the measurement from §7: human-audit a sample of *passed* members (cleared by both screen and confirm) for riders the system missed. The result is the silent-rider rate.

**Exit gate (a fork, not a checkbox):**
- Negligible → ship as is, residual documented. Stop here.
- Between → ship with the residual surfaced on the card; let defer do its job. Stop here.
- Material → proceed to Phase 3, now with a baseline to prove improvement against.

### Phase 3 — Directed test generation (conditional)

Only if Phase 2.5 returns a material rate. Replace general-purpose test generation in the confirm stage with directed/search-based generation aimed specifically at the diff, to push coverage toward changed code and surface silent behavioral deltas. Measure against the Phase 2.5 baseline; watch the false-positive rate on the drift indicator as a guardrail (§7).

---

## 9. Core data model (illustrative)

Shapes only; follow repo `CLAUDE.md` for style. These are starting points, not frozen contracts.

```typescript
interface PullRequest {
	id: string;
	declaredDirection: string;        // author-supplied prior; never trusted as verdict (INV-1)
	diff: Diff;
	filesTouched: ReadonlyArray<string>;
	symbolsTouched: ReadonlyArray<SymbolRef>;
}

interface Bundle {
	id: string;
	direction: string;                // the bundle's stated direction (the label)
	members: ReadonlyArray<PullRequest>;
}

// One enumerated, product-level effect of a diff, extracted blind to the declaration (INV-2).
interface Effect {
	clause: string;
	matchedDirection: boolean;        // set only after comparison, never during extraction
}

type DriftSignal =
	| { kind: "effectList"; orphanClauses: ReadonlyArray<string> }
	| { kind: "footprintAnomaly"; surprisingSymbols: ReadonlyArray<SymbolRef> }
	| { kind: "behavioralDelta"; description: string; classified: "intended" | "unintended" };

type DriftVerdict =
	| { status: "clean" }
	| { status: "flagged"; signals: ReadonlyArray<DriftSignal> };  // never "clean" via agreement alone (INV-3)

interface ReviewCard {
	bundleId: string;
	directionSummary: string;
	blastRadius: number;
	flags: ReadonlyArray<string>;     // e.g. "touches public API", "migration"
	drift: DriftVerdict;
}

type GestureAction = "accept" | "defer" | "reject";  // accept enqueues; does not merge (INV-5)
```

---

## 10. Open decisions

State the assumption made and proceed; do not block on these, but surface them.

- **Direction capture.** Does the swarm already emit a declared direction per PR? If not, capturing it at generation time is a prerequisite and is far preferable to reconstructing direction from diffs. Assumption for Phase 1: the swarm emits it; if it does not, the first task is making it do so.
- **Analyzer language(s).** Footprint/symbol resolution is per-language. Which language(s) does the swarm target? The static-analysis layer's difficulty is dominated by this. Assumption: build the orchestration language-agnostic and ship one analyzer first, behind a pluggable interface.
- **Bundling representation.** Directional similarity needs a representation of "direction" to cluster on. If the swarm declares direction as structured intent, clustering is a conformance check against a declared anchor; if not, it is an inference problem and noisier. Prefer the former.
- **Name.** Resolved: **Quire**. Before public launch, run the namespace and trademark checks discussed: GitHub org, npm package, domain, and a dev-tools trademark search. The word is obscure enough that the namespace is expected to be open, which is the upside of an archaic term; confirm rather than assume.

---

## 11. Prior art (orientation for the implementer)

These inform the approach; none is a drop-in dependency.

- **Tangled-commit / multi-concern detection** — frames the rider as multi-label concern detection; supports the "count concerns, don't score alignment" reframing and the finding that small fine-tuned models are usable up to ~3 concerns, which covers the large majority of tangled changes. (arXiv 2601.21298.)
- **Message-code inconsistency (MCI) detection** — the named field for the conformance check; note the empirical low specificity (detectors false-alarm on consistent commits) and the chain-of-thought precision/recall tradeoff, which motivates the two-stage screen-then-confirm split. (arXiv 2511.19875, CodeFuse-CommitEval.)
- **Behavioral-regression-via-intent (Testora)** — the executable witness for §6.2: generate tests, differential-test old vs. new, classify each behavioral delta against stated intent as intended/unintended. Directly addresses the structurally-local, semantically-plausible rider. (arXiv 2503.18597.)

---

## 12. Success metrics

- **Primary (value):** human decisions per hour on directional acceptance, vs. the pre-Quire baseline of per-PR review. This is the bottleneck the product exists to widen.
- **Trust:** drift-indicator false-positive rate (immaterial flags per accepted bundle) — guard this; it erodes trust on every bundle. And the silent-rider rate from Phase 2.5 — the measured residual.
- **Gate health:** in `shadow` mode, the auto-reject gate's false-positive rate per criterion, so users can graduate criteria to `enforce` on evidence.

Do not optimize for engagement, gesture speed, or volume processed. A faster swipe on an attention-bound problem just lets the user drown more comfortably; the win is fewer, better-supported decisions.

---

## 13. Mathematical and algorithmic techniques in the implementation

An inventory of every non-trivial mathematical or algorithmic technique in the codebase, for anyone auditing or extending the pipeline's math rather than its product logic. Everything not listed here (gate criteria, out-of-scope checks, `matcher.ts`, `clusterClassifier.ts`, the merge queue) is boolean/string-membership logic with no further arithmetic.

- **Connected components over a similarity graph, for bundling by direction** — `src/engine/bundle/similarity.ts` (`clusterPRs`, `matchingClusters`). Each PR is a node; an edge exists between two PRs when their extracted-effect-text similarity clears `config.threshold`. A cluster is a connected component of that graph, computed incrementally as PRs arrive: a new PR is compared against every individual member text of every existing cluster (not a single frozen "centroid" text), and if it clears the threshold against members of two or more different clusters, those clusters are merged into one before the new PR is added. This is what makes bundling transitive — A–B–C merge into one bundle when A~B and B~C both clear the threshold even if A~C alone does not, the shape a set of PRs pursuing different technical sub-approaches toward one shared product direction commonly takes (e.g. one bundle each doing texture baking, FBM octave tuning, raymarching step-skipping, lazy shader compilation, palette baking, and device-tier detection — every pair isn't mutually close, but the chain is). Before this fix, matching was greedy nearest-single-anchor: each cluster kept only its founding member's text as a permanent comparison target, so a bridging PR that matched a *later* member (not the founder) never got a chance to fold two clusters together. The embeddings path builds the true pairwise graph (cosine similarity is cheap once vectors are computed); the non-embeddings/classify path (single LLM call naming one match) can still only report one match per call, so it fixes the frozen-anchor problem but can't merge two clusters in a single step — a documented, protocol-level limitation, not a bug.
- **Cosine similarity over embedding vectors** — `src/engine/bundle/similarity.ts:9-20` (`cosineSimilarity`), `:28-44` (`textSimilarity`). Scores how alike two PRs' extracted-effect text is; the edge-weight function feeding the connected-components step above.
- **djb2-style string hashing, for stable bundle IDs** — `src/engine/bundle/bundler.ts` (`stableId`). Deterministic hash of the sorted member-PR-id set, so a bundle's id doesn't change across runs unless its membership does.
- **Composite fingerprint hashing, for review-card cache invalidation** — `src/engine/review/card.ts` (`computeInputsHash`). Concatenates each member's `headSha:declaredDirection:linkedIssueNumber`, sorted, plus the bundle id and effect summary, into one string key; `src/engine/pipeline/pipeline.ts` reuses a prior review card only when this hash is unchanged, avoiding recomputation of drift/blast-radius/flags for a bundle nothing relevant has touched.
- **Set overlap / intersection scoring** — `src/engine/gate/criteria/duplicate.ts` (`hasOverlap`): two PRs are flagged as duplicates only when they share a declared direction *and* their `filesTouched` sets intersect. `src/engine/bundle/conflictOrder.ts` (`entanglement`): counts, per bundle, how many *other* pending bundles share at least one touched file, and sorts the review queue by that count (ties broken by footprint size) so uncontested bundles surface first and heavily-entangled ones sink — minimizing the rebases a human triggers by clearing bundles in that order.
- **Footprint-anomaly detection via set difference** — `src/engine/drift/footprint/typescript.ts` (`computeExpectedFootprint`, a set-union of every bundle member's `filesTouched`) compared against a PR's own touched files via plain `Set` membership in `src/engine/drift/screen.ts`. Deliberately not a call/reference graph — no graph traversal is built here despite the "footprint" name; it is a flat set-membership check, high-recall by design (§6.1) because the confirm stage exists to raise precision on the flagged tail.
- **Blast radius, a set-cardinality aggregate** — `src/engine/review/blastRadius.ts` (`computeBlastRadius`): the size of the union of `filesTouched` across all bundle members, surfaced on the review card as a plain risk-size number.
- **Three-way merge / diff-region classification** — `src/engine/queue/conflictHunks.ts`, wrapping `node-diff3`'s `diff3Merge` to get an ordered list of agreed ("ok") vs. conflicting regions, then classifying each conflicting hunk as `"mechanical"` (same content once per-line leading/trailing whitespace is normalized) or `"semantic"` (needs LLM judgment) via a line-by-line equality comparison. Used by the merge queue's per-PR revert/conflict-resolution machinery (INV-4).
- **Confidence-gated decision fusion (fail-closed, not averaged)** — `src/engine/queue/semanticHunkResolver.ts` and `src/engine/queue/conflictResolution.ts`: aggregates per-hunk LLM confidence (`"high"` / `"low"`) into a file-level pass/fail by treating any unparseable-or-low-confidence hunk as a failure for the whole file, rather than averaging scores — the same fail-closed posture as INV-3 (agreement never clears on its own; only a positive signal does).
- **Bounded worker-pool concurrency** — `src/engine/util/concurrency.ts` (`settleWithConcurrency`): a shared-cursor producer/consumer pool that runs at most `limit` async calls in flight, each settled independently (so one failure doesn't sink the batch). Used to rate-limit embedding calls, effect extraction, and clustering comparisons against external LLM APIs — not bundling-specific math itself, but the concurrency envelope the graph-edge computations above run inside.
