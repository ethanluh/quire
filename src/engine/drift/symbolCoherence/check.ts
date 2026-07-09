import type { Bundle, DriftSignal, SymbolTouch } from "../../types/core.js";

// Groups symbol touches by name across every member of a bundle (each name's touches form a
// "face" — a k-way interaction, not just a pair) and flags faces where one member's edit
// removes/renames a name while another member still references it, with no third member's
// edit reconciling it (re-adding the name elsewhere in the bundle). Catches the case a pairwise
// conflict check misses: PR-A adds a name, PR-B removes/renames it, PR-C reads the old name —
// no PAIR of these looks wrong in isolation, only the merged whole does.
//
// Pure and bundle-wide on purpose: unlike runCheapScreen (per-member), this needs every
// member's touches at once to see interactions that don't exist within any single PR's diff.
export function findSymbolInconsistencies(
	bundle: Bundle,
	touchesByPr: ReadonlyMap<string, ReadonlyArray<SymbolTouch>>,
): ReadonlyArray<DriftSignal> {
	const faces = new Map<string, Array<{ prId: string; touch: SymbolTouch }>>();
	for (const member of bundle.members) {
		for (const touch of touchesByPr.get(member.id) ?? []) {
			const face = faces.get(touch.name) ?? [];
			face.push({ prId: member.id, touch });
			faces.set(touch.name, face);
		}
	}

	const signals: DriftSignal[] = [];
	for (const [name, entries] of faces) {
		const prIds = new Set(entries.map((e) => e.prId));
		if (prIds.size < 2) continue; // single-PR faces aren't a bundling-specific risk

		const goneEntries = entries.filter((e) => e.touch.operation === "remove" || e.touch.operation === "rename");
		if (goneEntries.length === 0) continue;

		// Deliberately no "is it re-added elsewhere?" reconciliation check: without real
		// rename-pairing or inter-PR ordering (v1 has neither, see TypeScriptAnalyzer), an
		// "add" of the same name from another member is indistinguishable between "that PR
		// originally introduced this name" (the removal is real) and "that PR restores what
		// was just removed" (the removal is reconciled) — both are a bare add touch with no
		// causal link to the removal. Treating any co-occurring add as reconciling would
		// silently clear the flag on exactly the motivating case (an original add + a
		// sibling's removal/rename). Over-flagging here matches the cheap screen's existing
		// design ("tuned for high recall... over-flags on purpose", see CLAUDE.md's Drift
		// check section) — the residual disclosure (review/card.ts) covers false negatives,
		// not false positives, but this trade-off is the same shape.
		const refEntries = entries.filter((e) => e.touch.operation === "reference");
		const conflicting = refEntries.filter((r) => goneEntries.some((g) => g.prId !== r.prId));
		if (conflicting.length === 0) continue;

		const touchedBy = entries.map((e) => ({ prId: e.prId, operation: e.touch.operation }));
		const anchor = goneEntries[0]!.touch;
		const implicated = new Set([...goneEntries.map((e) => e.prId), ...conflicting.map((e) => e.prId)]);
		for (const prId of implicated) {
			signals.push({
				kind: "symbolInconsistency",
				prId,
				symbol: { name, filePath: anchor.filePath, kind: anchor.kind },
				touchedBy,
				description:
					`"${name}" is removed/renamed by ${goneEntries.map((e) => e.prId).join(", ")} ` +
					`but referenced by ${conflicting.map((e) => e.prId).join(", ")}`,
			});
		}
	}
	return signals;
}
