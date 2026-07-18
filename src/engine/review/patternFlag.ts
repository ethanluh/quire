import type { Bundle } from "../types/core.js";
import type { PatternRegistryClient } from "../drift/patternRegistry/client.js";

// Best-effort, non-blocking: false positives here are expected to be far more common
// than in direction-honesty drift checks (effectList/footprintAnomaly), so a mismatch
// becomes a plain ReviewCard flag, never a DriftSignal. A registry lookup failure must
// never fail the whole review-card build, so errors are swallowed as "no flag".
export async function detectPatternFlag(bundle: Bundle, registry: PatternRegistryClient): Promise<string | undefined> {
	try {
		const result = await registry.checkPattern(bundle);
		if (result.matched) return undefined;
		const suffix = result.reason ? `: ${result.reason}` : result.changeClass ? ` for ${result.changeClass}` : "";
		return `unusual implementation pattern${suffix}`;
	} catch {
		return undefined;
	}
}
