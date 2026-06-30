import type { Bundle, Diff, SymbolRef } from "../../types/core.js";

export interface StaticAnalyzer {
	readonly language: string;
	analyzeSymbols(diff: Diff): Promise<ReadonlyArray<SymbolRef>>;
	computeExpectedFootprint(bundle: Bundle): Promise<ReadonlyArray<string>>;
}
