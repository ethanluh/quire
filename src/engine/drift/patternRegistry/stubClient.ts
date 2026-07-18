import type { Bundle } from "../../types/core.js";
import type { PatternCheckResult, PatternRegistryClient } from "./client.js";

export class StubPatternRegistryClient implements PatternRegistryClient {
	private result: PatternCheckResult = { matched: true };

	setResult(result: PatternCheckResult): void {
		this.result = result;
	}

	async checkPattern(_bundle: Bundle): Promise<PatternCheckResult> {
		return this.result;
	}
}
