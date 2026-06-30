import type { Bundle, DriftSignal, DriftVerdict, PullRequest } from "../types/core.js";
import type { LlmProvider } from "./effectList/provider.js";
import type { StaticAnalyzer } from "./footprint/analyzer.js";
import { extractEffects } from "./effectList/extractor.js";
import { matchEffectsToDirection } from "./effectList/matcher.js";

export async function runCheapScreen(
	pr: PullRequest,
	bundle: Bundle,
	provider: LlmProvider,
	analyzer: StaticAnalyzer,
): Promise<DriftVerdict> {
	const signals: DriftSignal[] = [];

	// Effect-list signal — extraction is blind to direction (INV-2)
	const rawClauses = await extractEffects(pr.diff, pr.testNamesChanged, provider);
	const effects = await matchEffectsToDirection(rawClauses, bundle.direction, provider);
	const orphanClauses = effects
		.filter((e) => !e.matchedDirection)
		.map((e) => e.clause);

	if (orphanClauses.length > 0) {
		signals.push({ kind: "effectList", orphanClauses });
	}

	// Footprint signal
	const [touchedSymbols, expectedFiles] = await Promise.all([
		analyzer.analyzeSymbols(pr.diff),
		analyzer.computeExpectedFootprint(bundle),
	]);

	const expectedSet = new Set(expectedFiles);
	const surprisingSymbols = touchedSymbols.filter((s) => !expectedSet.has(s.filePath));

	if (surprisingSymbols.length > 0) {
		signals.push({ kind: "footprintAnomaly", surprisingSymbols });
	}

	// INV-3: "clean" only when zero signals — never because all effects matched
	if (signals.length === 0) {
		return { status: "clean" };
	}
	return { status: "flagged", signals };
}
