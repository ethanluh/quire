import type { Bundle } from "../types/core.js";

// Orders pending review-queue bundles so a human working top-to-bottom minimizes downstream
// rebases: bundles that don't collide with anything else surface first (clear them quickly,
// no rebase risk either way), while bundles entangled with many others sink toward the
// bottom — by the time a human reaches one, some of its competitors will likely already be
// accepted/rejected/deferred, shrinking the set it would actually need to rebase against.
//
// Overlap is computed on filesTouched (already present on PullRequest, no analyzer needed —
// this is a plain set union/intersection, not language-specific) rather than symbolsTouched,
// matching the "footprint" granularity the drift screen already uses elsewhere.
export function orderByConflictRisk(bundles: ReadonlyArray<Bundle>): ReadonlyArray<string> {
	const footprints = new Map<string, ReadonlySet<string>>(
		bundles.map((bundle) => [bundle.id, new Set(bundle.members.flatMap((member) => member.filesTouched))]),
	);

	function entanglement(id: string): number {
		const footprint = footprints.get(id);
		if (footprint === undefined) return 0;
		let count = 0;
		for (const [otherId, otherFootprint] of footprints) {
			if (otherId === id) continue;
			for (const file of footprint) {
				if (otherFootprint.has(file)) {
					count++;
					break;
				}
			}
		}
		return count;
	}

	// Array.prototype.sort is stable (ES2019+), so bundles tied on both entanglement and
	// footprint size keep their original relative order without any extra tie-break logic.
	return [...bundles]
		.map((bundle) => ({ id: bundle.id, entanglement: entanglement(bundle.id), footprintSize: footprints.get(bundle.id)?.size ?? 0 }))
		.sort((a, b) => a.entanglement - b.entanglement || a.footprintSize - b.footprintSize)
		.map((scored) => scored.id);
}
