import type { Bundle, Diff, SymbolRef, SymbolTouch } from "../../types/core.js";

export interface StaticAnalyzer {
	readonly language: string;
	analyzeSymbols(diff: Diff): Promise<ReadonlyArray<SymbolRef>>;
	// Leave-one-out: the expected footprint for a member is derived from the OTHER
	// members' evidence. Including the screened member's own files would make its every
	// touch "expected" by construction and the footprintAnomaly signal a structural no-op.
	computeExpectedFootprint(bundle: Bundle, screenedPrId: string): Promise<ReadonlyArray<string>>;
	// Required, not optional: an optional method would let a future non-TS analyzer silently
	// no-op this check, producing a false "no inconsistency" verdict that violates INV-3's
	// "absence isn't proof" discipline (see src/engine/drift/symbolCoherence/check.ts).
	analyzeSymbolTouches(diff: Diff): Promise<ReadonlyArray<SymbolTouch>>;
}
