import type { Bundle } from "../../types/core.js";
import type { PatternCheckResult, PatternRegistryClient } from "./client.js";

// Default until a real pattern registry tool exists — always reports a match, so
// wiring this in today changes nothing observable.
export class NoopPatternRegistryClient implements PatternRegistryClient {
	async checkPattern(_bundle: Bundle): Promise<PatternCheckResult> {
		return { matched: true };
	}
}
