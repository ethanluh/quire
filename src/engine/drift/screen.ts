import type { Bundle, DriftSignal, DriftVerdict, PullRequest } from "../types/core.js";
import type { LlmProvider } from "./effectList/provider.js";
import type { StaticAnalyzer } from "./footprint/analyzer.js";
import { matchEffectsToDirection } from "./effectList/matcher.js";

export async function runCheapScreen(
	pr: PullRequest,
	bundle: Bundle,
	// Extracted blind to declaredDirection (INV-2) by the caller, e.g. bundler's
	// clustering pass — reused here rather than extracted twice.
	rawClauses: ReadonlyArray<string>,
	// The OTHER bundle members' extracted effects (leave-one-out) — the direction
	// evidence this member is compared against. Never includes this member's own
	// clauses: a comparison target containing them (like the old bundle-wide
	// effectSummary) self-matches by construction and can never surface an orphan.
	otherClauses: ReadonlyArray<string>,
	provider: LlmProvider,
	analyzer: StaticAnalyzer,
): Promise<DriftVerdict> {
	const signals: DriftSignal[] = [];

	// Both signals here are cross-member comparisons, so a singleton bundle has no
	// evidence to compare against — running them would either self-match (effect list)
	// or flag everything (empty expected footprint). Skip instead; the review card
	// discloses that singletons get no cheap-screen coverage (INV-6), which is honest
	// where a fabricated "clean from self-comparison" would not be.
	if (bundle.members.length < 2) {
		return { status: "clean" };
	}

	// Compared against the other members' extracted-effect evidence, never
	// bundle.direction (declaredDirection) — that field is a label, not a verdict
	// input (INV-1).
	const effects = await matchEffectsToDirection(rawClauses, otherClauses.join(". "), provider);
	const orphanClauses = effects
		.filter((e) => !e.matchedDirection)
		.map((e) => e.clause);

	if (orphanClauses.length > 0) {
		signals.push({ kind: "effectList", prId: pr.id, orphanClauses });
	}

	// Footprint signal — expected footprint is likewise leave-one-out (see
	// StaticAnalyzer.computeExpectedFootprint).
	const [touchedSymbols, expectedFiles] = await Promise.all([
		analyzer.analyzeSymbols(pr.diff),
		analyzer.computeExpectedFootprint(bundle, pr.id),
	]);

	const expectedSet = new Set(expectedFiles);
	const surprisingSymbols = touchedSymbols.filter((s) => !expectedSet.has(s.filePath));

	if (surprisingSymbols.length > 0) {
		signals.push({ kind: "footprintAnomaly", prId: pr.id, surprisingSymbols });
	}

	// INV-3: "clean" only when zero signals — never because all effects matched
	if (signals.length === 0) {
		return { status: "clean" };
	}
	return { status: "flagged", signals };
}

// The one place a signal is added to an already-built DriftVerdict (as opposed to a fresh
// verdict built from a signals array above) — used by callers that learn about a signal
// after the fact, e.g. a bundle-wide check that only has results once every member's own
// screen has already run (see orchestratePipeline's symbol-coherence pass).
export function appendDriftSignal(verdict: DriftVerdict, signal: DriftSignal): DriftVerdict {
	if (verdict.status === "flagged") {
		return { status: "flagged", signals: [...verdict.signals, signal] };
	}
	return { status: "flagged", signals: [signal] };
}
