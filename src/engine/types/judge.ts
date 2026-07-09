// Shared types for the Bundle Judge (docs/judge-integration-map.md). Kept in its own file,
// mirroring types/gate.ts and types/queue.ts, rather than folded into types/core.ts — the
// judge is an optional, additive subsystem layered on top of the core pipeline types, not a
// core data-model concept itself.

// Distinct from GateMode (types/gate.ts): "off" is a true kill switch (the judge never runs,
// never logs) — "shadow" still runs and logs, it just never acts. See
// docs/judge-integration-map.md §7 for why this is a 4-value superset of the mission's
// 3-value (shadow | assist | auto) description.
export type JudgeMode = "off" | "shadow" | "assist" | "auto";

export type JudgeGesture = "accept" | "defer" | "reject";

// The five rubric criteria a JudgeVerdict is scored against — fixed by the constitution's
// contract with JudgeVerdict (bundleJudge.ts, Phase 2), not configurable per deployment.
export type RubricCriterionKey = "direction" | "drift" | "blastRadius" | "reversibility" | "precedent";

// One human-readable guidance band for a rubric criterion, e.g. "0.8-1.0: the bundle is a
// clean, on-direction extension of an already-accepted precedent." Bands are read by the
// judge prompt builder (bundleJudge.ts) verbatim — the written guidance IS the calibration
// signal, not just documentation.
export interface RubricScoreBand {
	minScore: number;
	maxScore: number;
	description: string;
}

export interface RubricCriterion {
	key: RubricCriterionKey;
	label: string;
	bands: ReadonlyArray<RubricScoreBand>;
}

// One entry in the risk taxonomy — "what counts as high-risk / could do hard damage /
// irreversible." A match on any entry means ESCALATE, never auto-act, full stop (see
// judge-constitution.md's "Risk taxonomy" section and gate.ts, Phase 3). filePatterns are
// regex source strings (JSON can't hold a RegExp literal) compiled once at load time by
// constitution.ts — a single bad pattern in the doc fails the whole load loudly, not silently.
export interface RiskTaxonomyEntry {
	id: string;
	label: string;
	description: string;
	filePatterns: ReadonlyArray<string>;
}

// A taxonomy entry with its patterns pre-compiled — what riskTaxonomy.ts actually matches
// against, kept separate from RiskTaxonomyEntry (the plain-data, JSON-serializable shape)
// so a compiled RegExp never has to round-trip through JSON.stringify.
export interface CompiledRiskTaxonomyEntry {
	id: string;
	label: string;
	description: string;
	filePatterns: ReadonlyArray<RegExp>;
}

// Auto-act gating thresholds — see gate.ts (Phase 3) for the AND rule that combines these
// with blast radius, reversibility, and a risk-taxonomy match. Doc-provided defaults; a
// deployment may override via env vars (QUIRE_JUDGE_AUTOACCEPT_CONFIDENCE etc., Phase 3) —
// the env var, when set, wins, mirroring how a UI-connected LLM account takes priority over
// resolveLlmProvider's env-based defaults elsewhere in this codebase.
export interface JudgeThresholds {
	autoAcceptConfidence: number;
	// Higher than autoAcceptConfidence by construction (a wrong auto-reject triggers a swarm
	// regen loop, which is more expensive to undo than a wrong auto-accept sitting reversibly
	// in the merge queue) — constitution.ts validates this ordering at load time.
	autoRejectConfidence: number;
	maxBlastRadiusAuto: number;
}

export interface JudgeConstitution {
	version: number;
	rubric: ReadonlyArray<RubricCriterion>;
	riskTaxonomy: ReadonlyArray<CompiledRiskTaxonomyEntry>;
	thresholds: JudgeThresholds;
}

// A bundle's score against each rubric criterion — every key is mandatory (see
// bundleJudge.ts's schema): a verdict missing one is malformed, exactly like a
// semanticHunkResolver.ts attempt missing a hunk.
export interface JudgeCriteriaScores {
	direction: number;
	drift: number;
	blastRadius: number;
	reversibility: number;
	precedent: number;
}

// The judge's structured output for one bundle. Never trusted directly (INV-1) — gate.ts
// (Phase 3) is what actually decides whether this verdict is allowed to drive an autonomous
// action; the verdict itself is only ever a declaration, same status as declaredDirection.
export interface JudgeVerdict {
	gesture: "accept" | "defer" | "reject";
	confidence: number;
	criteria: JudgeCriteriaScores;
	// Union of the deterministic riskTaxonomy.ts matches and whatever the model itself
	// names — docs/judge-constitution.md: "a match from either source is treated
	// identically." Always taxonomy `id`s, never free-form text, so gate.ts can compare
	// against the constitution's own taxonomy list.
	riskFlags: ReadonlyArray<string>;
	rationale: string;
	// bundleId of each PrecedentExample (precedent.ts) the model actually weighed —
	// lets a human (or the audit-sampling check, Phase 5) verify the citation is real
	// rather than trusting the model's own claim that it consulted precedent.
	precedentIds: ReadonlyArray<string>;
	// provider.modelKey (e.g. "anthropic:claude-opus-4-8") — which model produced this,
	// so a later audit can tell whether bias mitigation (a distinct judge model, see
	// resolveJudgeProvider.ts) was actually active for this specific verdict.
	modelId: string;
}

// One past bundle a human already decided on, retrieved as few-shot grounding for the
// current candidate (precedent.ts). Never includes a bundle the judge itself decided —
// precedent must be a human's own directional call, not the judge's, or "precedent match"
// would silently become the judge grading itself against its own prior outputs.
export interface PrecedentExample {
	bundleId: string;
	direction: string;
	effectSummary: string;
	gesture: "accept" | "reject" | "defer";
	// Word-overlap similarity to the candidate bundle's effectSummary, 0..1 — informational
	// (used for ranking/testing), not itself sent to the model as a score.
	similarity: number;
}
