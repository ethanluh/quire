import type { Bundle, DriftVerdict, ReviewCard, SpecConformanceSignal, SpecConformanceVerdict } from "../types/core.js";
import type { SpecConformanceResult } from "../specConformance/check.js";
import { computeBlastRadius } from "./blastRadius.js";
import { detectFlags, isHighRisk } from "./flags.js";

const RESIDUAL_DISCLOSURE =
	"Behavioral confirm is not yet active. Rare undeclared changes in structurally local, " +
	"behaviorally silent code may not be caught. Cross-PR symbol-consistency checking is " +
	"regex-based (no rename detection in v1, and reference-detection may miss non-standard " +
	"import styles) and matches on bare symbol name only, with no cross-file import " +
	"resolution — two unrelated PRs that happen to touch a same-named symbol in different " +
	"files may be flagged as if in conflict. Absence of a symbol-inconsistency flag is not " +
	"proof the bundle's symbols are consistent.";

// The cheap screen's signals (effect-list orphans, footprint anomaly) and the
// symbol-coherence check are all cross-member comparisons; with one member there is no
// other evidence to compare against, so none of them ran. Said outright (INV-6) rather
// than letting the "clean" drift verdict read as "checked and passed".
const SINGLETON_DISCLOSURE =
	" This bundle has a single member: the effect-list, footprint-anomaly, and " +
	"symbol-consistency checks are cross-PR comparisons and produced no signal for it — " +
	"its drift verdict reflects an unchecked member, not a passed check.";

// A cheap fingerprint of everything blastRadius/flags/drift/specConformance are computed
// from: which PRs are in the bundle (bundle.id already hashes the sorted member-id set),
// each member's content version (headSha — filesTouched/diff-derived fields are tied to
// this), the anchor's extracted-effect text (effectSummary, the drift-comparison target),
// and — unlike drift — each member's declaredDirection and linkedIssueNumber. Those two
// are deliberately NOT excluded here the way bundle.direction (directionSummary) is: they
// are the actual spec-conformance comparison inputs, so a PR-body-only edit (no new commit,
// same headSha) that redeclares the direction or changes the linked issue must invalidate
// this hash — that edit is exactly the scenario spec conformance exists to catch. Two
// bundles with an identical hash are guaranteed to produce identical blastRadius/flags/
// drift/specConformance from buildReviewCard.
export function computeInputsHash(bundle: Bundle): string {
	const memberFingerprints = bundle.members
		.map((m) => `${m.headSha}:${m.declaredDirection}:${m.linkedIssueNumber ?? ""}`)
		.sort()
		.join(",");
	return `${bundle.id}|${memberFingerprints}|${bundle.effectSummary}`;
}

export function buildReviewCard(
	bundle: Bundle,
	driftVerdicts: ReadonlyMap<string, DriftVerdict>,
	specResultsByPr: ReadonlyMap<string, SpecConformanceResult>,
): ReviewCard {
	const anchor = bundle.members[0];
	if (anchor === undefined) throw new Error("Bundle must have at least one member");

	const memberVerdicts = bundle.members.map((m) => driftVerdicts.get(m.id));
	// One entry per implicated PR (not deduped) on purpose: prDriftBadges (render.js) derives
	// each PR's own badge by filtering this same flattened list by prId, so collapsing a
	// bundle-wide symbolInconsistency signal here would silently drop the badge for whichever
	// PR's copy got deduped away. The bundle-level "Drift signals" list view (renderSignals)
	// dedupes for display instead, without touching this per-PR-badge-bearing data.
	const signals = memberVerdicts.flatMap((v) => (v?.status === "flagged" ? [...v.signals] : []));
	const drift: DriftVerdict = signals.length > 0 ? { status: "flagged", signals } : { status: "clean" };
	const flags = detectFlags(bundle);

	// "inconclusive" (no linked issue, a failed fetch, or an unparseable model response)
	// is not a flag — it's disclosed instead (INV-6), same spirit as residualDisclosure
	// above: don't let a "clean" specConformance verdict be mistaken for "we checked and
	// it matched" when really nothing was checked at all.
	const specSignals: SpecConformanceSignal[] = [];
	let uncheckedCount = 0;
	for (const member of bundle.members) {
		const result = specResultsByPr.get(member.id);
		if (result === undefined || result.outcome === "inconclusive") {
			uncheckedCount++;
		} else if (result.outcome === "flagged") {
			specSignals.push({ prId: member.id, explanation: result.explanation });
		}
	}
	const specConformance: SpecConformanceVerdict =
		specSignals.length > 0 ? { status: "flagged", signals: specSignals } : { status: "clean" };
	const specConformanceDisclosure =
		uncheckedCount > 0
			? `${uncheckedCount} of ${bundle.members.length} member(s) had no linked issue (or it could not be checked); spec conformance was not checked for them.`
			: "";

	return {
		bundleId: bundle.id,
		directionSummary: bundle.direction,
		directionInferred: bundle.directionInferred,
		repoOwner: anchor.repoOwner,
		repoName: anchor.repoName,
		blastRadius: computeBlastRadius(bundle),
		flags,
		drift,
		residualDisclosure:
			bundle.members.length === 1 ? RESIDUAL_DISCLOSURE + SINGLETON_DISCLOSURE : RESIDUAL_DISCLOSURE, // INV-6: always set
		specConformance,
		specConformanceDisclosure,
		inputsHash: computeInputsHash(bundle),
		memberCount: bundle.members.length,
		requiresAcceptConfirmation: isHighRisk(flags),
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
		directionInferred: bundle.directionInferred,
		repoOwner: anchor.repoOwner,
		repoName: anchor.repoName,
		memberCount: bundle.members.length,
	};
}
