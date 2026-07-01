import type { GateDecisionLog } from "./instrumentation.js";

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

export interface GateResult {
	prId: string;
	outcome: GateOutcome;
	decisions: ReadonlyArray<GateDecisionLog>;
}
