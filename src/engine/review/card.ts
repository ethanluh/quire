import type { Bundle, DriftVerdict, ReviewCard } from "../types/core.js";
import { computeBlastRadius } from "./blastRadius.js";
import { detectFlags } from "./flags.js";

const RESIDUAL_DISCLOSURE =
	"Behavioral confirm is not yet active. Rare undeclared changes in structurally local, behaviorally silent code may not be caught.";

// A cheap fingerprint of everything blastRadius/flags/drift are computed from: which PRs
// are in the bundle (bundle.id already hashes the sorted member-id set), each member's
// content version (headSha — filesTouched/diff-derived fields are tied to this), and the
// anchor's extracted-effect text (effectSummary, the actual drift-comparison target).
// Two bundles with an identical hash are guaranteed to produce identical blastRadius/
// flags/drift from buildReviewCard — directionSummary is deliberately excluded (see
// reuseReviewCard) since declaredDirection is metadata, not a drift-check input (INV-1),
// and can change independent of everything else this hashes.
export function computeInputsHash(bundle: Bundle): string {
	const headShas = bundle.members.map((m) => m.headSha).sort().join(",");
	return `${bundle.id}|${headShas}|${bundle.effectSummary}`;
}

export function buildReviewCard(
	bundle: Bundle,
	driftVerdicts: ReadonlyMap<string, DriftVerdict>,
): ReviewCard {
	const anchor = bundle.members[0];
	if (anchor === undefined) throw new Error("Bundle must have at least one member");

	const memberVerdicts = bundle.members.map((m) => driftVerdicts.get(m.id));
	const signals = memberVerdicts.flatMap((v) => (v?.status === "flagged" ? [...v.signals] : []));
	const drift: DriftVerdict = signals.length > 0 ? { status: "flagged", signals } : { status: "clean" };

	return {
		bundleId: bundle.id,
		directionSummary: bundle.direction,
		repoOwner: anchor.repoOwner,
		repoName: anchor.repoName,
		blastRadius: computeBlastRadius(bundle),
		flags: detectFlags(bundle),
		drift,
		residualDisclosure: RESIDUAL_DISCLOSURE, // INV-6: always set
		inputsHash: computeInputsHash(bundle),
		memberCount: bundle.members.length,
	};
}

// Reuses a prior card's expensive-to-compute fields (drift verdict, blast radius, flags)
// once computeInputsHash has proven nothing they depend on changed, while still
// refreshing directionSummary from the bundle's current declaredDirection — a PR body
// edit with no new commit changes declaredDirection without changing inputsHash, and
// that must never go stale on the reuse path.
export function reuseReviewCard(bundle: Bundle, priorCard: ReviewCard): ReviewCard {
	const anchor = bundle.members[0];
	if (anchor === undefined) throw new Error("Bundle must have at least one member");

	return {
		...priorCard,
		bundleId: bundle.id,
		directionSummary: bundle.direction,
		repoOwner: anchor.repoOwner,
		repoName: anchor.repoName,
		memberCount: bundle.members.length,
	};
}
