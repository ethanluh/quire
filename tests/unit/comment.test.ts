import { describe, it, expect } from "@jest/globals";
import { formatReviewCardComment } from "../../src/engine/review/comment.js";
import type { ReviewCard } from "../../src/engine/types/core.js";

function makeCard(overrides: Partial<ReviewCard> = {}): ReviewCard {
	return {
		bundleId: "b-1",
		directionSummary: "add passwordless auth",
		blastRadius: 3,
		flags: [],
		drift: { status: "clean" },
		residualDisclosure: "behavioral confirm not run",
		inputsHash: "hash-1",
		memberCount: 1,
		...overrides,
	};
}

describe("formatReviewCardComment", () => {
	it("includes the action, direction, blast radius, and residual disclosure", () => {
		const body = formatReviewCardComment("accept", makeCard());

		expect(body).toContain("Accepted");
		expect(body).toContain("add passwordless auth");
		expect(body).toContain("3 files");
		expect(body).toContain("behavioral confirm not run");
	});

	it("lists flags when present and 'none' when absent", () => {
		expect(formatReviewCardComment("reject", makeCard({ flags: ["public API"] }))).toContain("public API");
		expect(formatReviewCardComment("reject", makeCard({ flags: [] }))).toContain("Flags: none");
	});

	it("surfaces a flagged drift verdict with its signal count", () => {
		const body = formatReviewCardComment(
			"defer",
			makeCard({
				drift: {
					status: "flagged",
					signals: [{ kind: "footprintAnomaly", prId: "pr-1", surprisingSymbols: [] }],
				},
			}),
		);

		expect(body).toContain("flagged (1 signal)");
	});
});
