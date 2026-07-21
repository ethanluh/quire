# Quire Teardown & Rebuild — Multi-Perspective Research Pass

## Context

A deep research pass on Quire's design: a mixed team of supportive and adversarial perspectives tears the idea down to its simplest aspects, then rebuilds it. This is a critique/analysis document, not a change proposal — nothing here is implemented by this doc.

Grounding fact-check (read-only pass over the repo at the time of writing):
- **Phase 1 (MVP) is real and solid**: ingest → gate → bundle → cheap screen → review card → gestures → merge queue all have working code and passing tests (278 tests, 84 files under `src/engine`, zero TODO/stub markers).
- **Gate** (`src/engine/gate/`): enforce/shadow/off modes work, but only 3 criteria exist (`buildFailure`, `outOfScope`, `duplicate`) — `testFailure` was deliberately folded into `buildFailure` because CI data can't distinguish them.
- **Cheap screen** (`src/engine/drift/`): effect-list matching, footprint anomaly, and symbol-coherence are all real — but the static analyzer only supports **TypeScript**. "One implementation per target language" is aspirational beyond that.
- **LLM wiring**: real Anthropic/Gemini providers with retry logic, not mocked, with a stub fallback only when no API key is configured.
- **Merge queue**: real GitHub API calls (merge, branch update, revert), with locking for INV-4/INV-5.
- **Phase 2/2.5/3** (behavioral confirm, silent-rider measurement, directed test generation): **100% absent**, and the product is honest about it in-UI ("Behavioral confirm is not yet active").

So the critique below is about a real, working Phase-1 system with an honestly-disclosed capability ceiling — not vaporware.

---

## The Team

**Priya (Systems Architect, supportive)** — built triage tools before, believes in the bundling premise.
**Dmitri (Adversarial Skeptic, ML/Detection)** — has shipped and killed static-analysis products, distrusts LLM-based extraction claims.
**Sam (Adversarial, Product/Market)** — thinks the whole premise is solving a problem that shouldn't exist.
**Yuki (Security/Trust reviewer, adversarial)** — asks "what happens when this is wrong, and who's accountable."
**Elena (Supportive, pragmatic PM)** — has watched teams drown in PR review queues, wants to know if this is actually 10x better than the status quo.

---

## Round 1: Tear It Down

### Sam (adversarial) — the premise itself

> "Why does a swarm of coding agents producing overlapping/duplicate PRs need a *triage layer* instead of a *coordination layer*? You're building sophisticated tooling to clean up after a mess that a better orchestrator upstream wouldn't create in the first place. INV-1 through INV-6 are essentially: 'we don't trust the agents, and we don't trust ourselves to trust them, so here's a forensics department.' That's a symptom of the swarm having no shared state or planning coordination — Quire is a bandage on architecture debt one layer up."

This lands hardest against the *product's reason to exist*, not its execution. It doesn't kill the idea, but it reframes it: Quire is valuable specifically in a world where swarm coordination is hard/expensive/impossible to get right upstream.

### Dmitri (adversarial) — the detection claims

> "Effect-list extraction 'blind to declaredDirection' sounds rigorous, but it's still an LLM reading a diff and guessing intent. INV-2 protects against a labeling bias, not against the extraction being wrong. You have zero language coverage outside TypeScript for the static analyzer — so footprint anomaly and symbol-coherence, your only *non-LLM* signals, don't exist for Python, Go, Rust, anything else. That means for any non-TS codebase, drift detection is 100% LLM opinion with no independent check. Phase 0's job was supposed to be calibrating false-positive/negative rates before writing detectors — has that report actually been produced, or did Phase 1 get built on assumed calibration?"

This is the sharpest technical finding: **the cheap screen's "two independent signals" story (LLM effect-list + static analysis) collapses to one signal (LLM only) for every non-TypeScript repo.** That's a real single-point-of-failure risk for the accuracy-critical layer of a tool whose entire pitch is "don't verify correctness, but do catch drift."

### Yuki (adversarial) — trust and accountability

> "INV-5 has an opt-in `autoMergeOnAccept` escape hatch. The instant someone flips that on, you've collapsed the 'always reversible until merge queue lands it' safety property into 'irreversible the moment a human clicks accept on a *bundle* they may not have individually inspected every PR within.' A bundle is a UX convenience for the human, but the merge queue still merges N individual PRs. If PR #3 in a 5-PR bundle has a subtle security regression that didn't trip any of your 3 gate criteria or the TS-only drift check, nothing in this pipeline stops it — the human accepted a 'direction,' not five diffs. Where's the disclosure that a bundle-accept can hide a bad individual member?"

INV-6 ("surface what the system could not clear") is the intended answer to this — but it's only as good as what actually gets surfaced. If the residual disclosure is a static string like the Phase 2 placeholder, it's not really *surfacing* per-bundle risk, just a boilerplate disclaimer.

### Priya (supportive) — steelmanning the architecture

> "The phase discipline is the best thing about this project. Most teams build the expensive stuff (Phase 2 sandboxed differential testing) speculatively and never measure whether it was needed. Quire's Phase 0 → 2.5 gating means expensive verification is *conditional on measured drift*, not assumed. And the invariant set (INV-1 through INV-6) is unusually precise for a project this size — most 'trust but verify' pipelines don't bother formalizing what 'agreement' vs 'disagreement' is allowed to do (INV-3: disagreement flags, agreement never clears). That's a genuinely good design instinct: false negatives from the cheap signal are quietly forgiven only by an independent check, never by more of the same signal agreeing with itself."

### Elena (supportive, pragmatic) — does it beat the status quo

> "The comparison isn't 'Quire vs. perfect verification,' it's 'Quire vs. a human scrolling through 40 similar-looking PRs from a swarm and manually figuring out which three are actually the same feature.' Even the TS-only, 3-criteria, no-Phase-2 version probably beats that baseline by a lot, because the baseline is *nothing* — no bundling at all. The real question isn't 'is this rigorous enough' but 'does grouping-by-direction reduce decision count enough to be worth the false-bundle risk Yuki described.' That's an empirical question Phase 0 was supposed to answer, and it's unclear it was."

---

## Round 2: What Survives the Teardown

Cutting to what's load-bearing vs. decorative:

1. **The core insight survives**: one directional decision per bundle instead of one per PR is a real leverage point *if* bundling accuracy is high enough that mis-bundling costs less than the review time saved. Nobody on the team disputes the mechanism — the dispute is whether current signal quality supports it outside TypeScript.
2. **INV-1/INV-2/INV-3 (declaration is a label, not a verdict; blind extraction; disagreement-only-flags) are sound and should be kept as-is.** This is good epistemic hygiene, not overengineering.
3. **The phase-gating discipline (0 → 1 → 2 → 2.5 → 3) is a genuine strength, not a stalling tactic** — conditional on Phase 0 actually being run before claiming Phase 1 is "done." That's unverified from the codebase alone (calibration data isn't code).
4. **The single-signal-for-non-TS gap is the most concrete, fixable finding.** It's not an indictment of the architecture, just an honest coverage gap that should be disclosed on the review card (INV-6) rather than silently treated as equivalent to TS repos.
5. **The bundle-accept-hides-individual-risk gap (Yuki's finding) is a UX/disclosure problem, not an architecture problem.** The invariants already support surfacing per-member risk (INV-6); the review card just needs to make bundle-level acceptance show member-level residual risk, not a single aggregate disclosure string.
6. **Sam's "this is a symptom of upstream coordination debt" critique is correct but doesn't kill the product** — it correctly identifies *why* Quire is valuable (swarm coordination is genuinely hard), it just means Quire's value is contingent on that upstream debt persisting, which is a reasonable, if not permanent, bet.

---

## Round 3: Rebuild — Recommendations

In priority order, if this were the "what should change" punch list:

1. **Disclose signal degradation, not just absence.** When a bundle's members aren't TypeScript, the review card (INV-6) should explicitly say "static analysis unavailable — drift verdict is LLM-only," not just show the same `DriftVerdict` shape as a TS bundle. Right now a "clean" verdict looks identical whether it was checked two ways or one.
2. **Run and publish the Phase 0 calibration report before treating Phase 1 as validated**, if that hasn't already happened outside the repo. Keep-rate and drift base-rate numbers are the only way to arbitrate the Priya/Dmitri disagreement above — this is a measurement gap, not a code gap.
3. **Tighten the `autoMergeOnAccept` escape hatch's disclosure.** Since it's opt-in and off by default, the risk is contained, but consider surfacing per-member (not just per-bundle) residual risk specifically for accounts that have this flag on, since the human-in-the-loop safety net (INV-5's default reversibility) is exactly what that flag removes.
4. **Second-language static analyzer is the highest-leverage next investment**, ahead of Phase 2 behavioral confirm — it directly fixes the "one signal only" gap for any non-TS repo, and is architecturally already slotted in (`StaticAnalyzer` interface, per-language pluggable per the module boundaries doc). Phase 2 (sandboxed differential testing) is expensive and explicitly gated on Phase 0 showing material drift; a second analyzer has no such gate and closes a known coverage hole today.
5. **Grow the gate criterion library deliberately, not reactively.** 3 criteria (buildFailure, outOfScope, duplicate) is thin; before adding more, decide whether new criteria default to `shadow` mode first (per the existing enforce/shadow/off model) so their false-positive rate is measured before they can silently discard a PR.

---

## What This Report Is Not

This isn't a request to implement any of the above. It's a teardown-and-rebuild analysis pass. If any of the five rebuild items become actual work, that would be a separate, scoped planning pass per item (a new worktree/PR each, per the "one topic per branch" rule) — not a bundled change.
