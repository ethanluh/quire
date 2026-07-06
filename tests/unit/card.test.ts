import { describe, it, expect } from "@jest/globals";
import { buildReviewCard, reuseReviewCard } from "../../src/engine/review/card.js";
import type { Bundle, PullRequest, ReviewCard } from "../../src/engine/types/core.js";

function makePR(id: string, overrides: Partial<PullRequest> = {}): PullRequest {
	return {
		id,
		repoOwner: "org",
		repoName: "repo",
		number: 1,
		headSha: `sha-${id}`,
		declaredDirection: "add passwordless auth",
		diff: { raw: "", hunks: [] },
		filesTouched: [`src/${id}.ts`],
		symbolsTouched: [],
		testNamesChanged: [],
		ciStatus: "success",
		...overrides,
	};
}

function makeBundle(members: ReadonlyArray<PullRequest>): Bundle {
	const anchor = members[0];
	if (anchor === undefined) throw new Error("Bundle must have at least one member");
	return {
		id: "b-1",
		direction: anchor.declaredDirection,
		effectSummary: "adds OTP-based login",
		members,
	};
}

describe("buildReviewCard — repo derivation", () => {
	it("derives repoOwner/repoName from the bundle's first member", () => {
		const bundle = makeBundle([makePR("pr-1", { repoOwner: "acme", repoName: "widgets" })]);

		const card = buildReviewCard(bundle, new Map());

		expect(card.repoOwner).toBe("acme");
		expect(card.repoName).toBe("widgets");
	});
});

describe("reuseReviewCard — repo derivation", () => {
	it("refreshes repoOwner/repoName from the current bundle, not the prior card", () => {
		const priorCard: ReviewCard = {
			bundleId: "b-1",
			directionSummary: "add passwordless auth",
			repoOwner: "stale-owner",
			repoName: "stale-repo",
			blastRadius: 1,
			flags: [],
			drift: { status: "clean" },
			residualDisclosure: "behavioral confirm not run",
			inputsHash: "hash-1",
			memberCount: 1,
		};
		const bundle = makeBundle([makePR("pr-1", { repoOwner: "acme", repoName: "widgets" })]);

		const card = reuseReviewCard(bundle, priorCard);

		expect(card.repoOwner).toBe("acme");
		expect(card.repoName).toBe("widgets");
	});
});
