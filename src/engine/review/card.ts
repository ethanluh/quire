import type { Bundle, DriftVerdict, ReviewCard } from "../types/core.js";
import { computeBlastRadius } from "./blastRadius.js";
import { detectFlags } from "./flags.js";

const RESIDUAL_DISCLOSURE =
	"Behavioral confirm is not yet active. Rare undeclared changes in structurally local, behaviorally silent code may not be caught.";

export function buildReviewCard(
	bundle: Bundle,
	driftVerdicts: ReadonlyMap<string, DriftVerdict>,
): ReviewCard {
	const memberVerdicts = bundle.members.map((m) => driftVerdicts.get(m.id));
	const anyFlagged = memberVerdicts.some((v) => v?.status === "flagged");

	const drift: DriftVerdict = anyFlagged
		? {
				status: "flagged",
				signals: memberVerdicts
					.filter((v): v is Extract<DriftVerdict, { status: "flagged" }> => v?.status === "flagged")
					.flatMap((v) => [...v.signals]),
			}
		: { status: "clean" };

	return {
		bundleId: bundle.id,
		directionSummary: bundle.direction,
		blastRadius: computeBlastRadius(bundle),
		flags: detectFlags(bundle),
		drift,
		residualDisclosure: RESIDUAL_DISCLOSURE, // INV-6: always set
	};
}
