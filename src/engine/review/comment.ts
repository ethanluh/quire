import type { GestureAction, ReviewCard } from "../types/core.js";

const ACTION_LABEL: Record<GestureAction, string> = {
	accept: "Accepted",
	reject: "Rejected",
	defer: "Deferred",
};

export function formatReviewCardComment(action: GestureAction, card: ReviewCard): string {
	const lines = [
		`**Quire triage verdict: ${ACTION_LABEL[action]}**`,
		"",
		`- Direction: ${card.directionSummary}`,
		`- Blast radius: ${card.blastRadius} file${card.blastRadius === 1 ? "" : "s"}`,
		`- Flags: ${card.flags.length > 0 ? card.flags.join(", ") : "none"}`,
		`- Drift: ${
			card.drift.status === "flagged"
				? `flagged (${card.drift.signals.length} signal${card.drift.signals.length === 1 ? "" : "s"})`
				: "clean"
		}`,
		"",
		card.residualDisclosure,
	];

	return lines.join("\n");
}
