import type { Bundle } from "../types/core.js";
import type { CompiledRiskTaxonomyEntry } from "../types/judge.js";

// Deterministic half of risk-taxonomy matching — mirrors review/flags.ts's file-pattern
// technique exactly (regex over every member's filesTouched), but against the constitution's
// configurable taxonomy rather than a hardcoded list. Entries with no filePatterns (e.g.
// "unclear-revert-path" in docs/judge-constitution.md) can never match here by construction —
// those are judge-reasoning-only and are expected to appear in JudgeVerdict.riskFlags
// directly from the model's own output, not from this function. The gate (Phase 3) treats a
// match from either source identically.
export function matchRiskTaxonomy(bundle: Bundle, taxonomy: ReadonlyArray<CompiledRiskTaxonomyEntry>): ReadonlyArray<string> {
	const allFiles = bundle.members.flatMap((m) => [...m.filesTouched]);
	const matched: string[] = [];
	for (const entry of taxonomy) {
		if (entry.filePatterns.some((pattern) => allFiles.some((file) => pattern.test(file)))) {
			matched.push(entry.id);
		}
	}
	return matched;
}
