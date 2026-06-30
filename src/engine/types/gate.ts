export type GateMode = "enforce" | "shadow" | "off";

export interface GateCriterion {
	name: string;
	mode: GateMode;
}

export interface GateConfig {
	criteria: ReadonlyArray<GateCriterion>;
	scopeKeywords?: ReadonlyArray<string>;
}

export type GateOutcome =
	| { result: "pass" }
	| { result: "reject"; criterionName: string; reason: string }
	| { result: "shadow"; criterionName: string; reason: string };

export interface GateCriterionOutcome {
	criterionName: string;
	mode: GateMode;
	triggered: boolean;
}

export interface GateResult {
	prId: string;
	outcome: GateOutcome;
	// Every criterion actually evaluated (mode "enforce" or "shadow"), independent of the
	// final outcome above — instrumentation needs per-criterion data even for criteria that
	// didn't end up deciding the PR's fate (e.g. a shadow hit on a PR enforce-rejected by
	// another criterion).
	criteriaOutcomes: ReadonlyArray<GateCriterionOutcome>;
}
