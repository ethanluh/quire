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
