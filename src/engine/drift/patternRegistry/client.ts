import type { Bundle } from "../../types/core.js";

export interface PatternCheckResult {
	matched: boolean;
	// The registry's own classification of the bundle's change, informational only.
	changeClass?: string;
	// Human-readable mismatch description, present when matched is false.
	reason?: string;
}

export interface PatternRegistryClient {
	checkPattern(bundle: Bundle): Promise<PatternCheckResult>;
}
