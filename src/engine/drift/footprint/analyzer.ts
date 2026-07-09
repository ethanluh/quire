import type { Bundle, Diff, SymbolRef, SymbolTouch } from "../../types/core.js";

export interface StaticAnalyzer {
	readonly language: string;
	analyzeSymbols(diff: Diff): Promise<ReadonlyArray<SymbolRef>>;
	computeExpectedFootprint(bundle: Bundle): Promise<ReadonlyArray<string>>;
	// Required, not optional: an optional method would let a future non-TS analyzer silently
	// no-op this check, producing a false "no inconsistency" verdict that violates INV-3's
	// "absence isn't proof" discipline (see src/engine/drift/symbolCoherence/check.ts).
	analyzeSymbolTouches(diff: Diff): Promise<ReadonlyArray<SymbolTouch>>;
}
