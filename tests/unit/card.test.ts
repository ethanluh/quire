import { describe, it, expect } from "@jest/globals";
import { buildReviewCard, computeInputsHash, reuseReviewCard } from "../../src/engine/review/card.js";
import type { Bundle, PullRequest, ReviewCard } from "../../src/engine/types/core.js";
import type { SpecConformanceResult } from "../../src/engine/specConformance/check.js";

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

		const card = buildReviewCard(bundle, new Map(), new Map());

		expect(card.repoOwner).toBe("acme");
		expect(card.repoName).toBe("widgets");
	});
});

describe("buildReviewCard — specConformance aggregation", () => {
	it("is clean and undisclosed when every member conforms", () => {
		const pr1 = makePR("pr-1");
		const bundle = makeBundle([pr1]);
		const specResults = new Map<string, SpecConformanceResult>([["pr-1", { outcome: "clean" }]]);

		const card = buildReviewCard(bundle, new Map(), specResults);

		expect(card.specConformance).toEqual({ status: "clean" });
		expect(card.specConformanceDisclosure).toBe("");
	});

	it("flags with a per-member signal when a member's result is flagged", () => {
		const pr1 = makePR("pr-1");
		const bundle = makeBundle([pr1]);
		const specResults = new Map<string, SpecConformanceResult>([
			["pr-1", { outcome: "flagged", explanation: "redefined the task" }],
		]);

		const card = buildReviewCard(bundle, new Map(), specResults);

		expect(card.specConformance).toEqual({
			status: "flagged",
			signals: [{ prId: "pr-1", explanation: "redefined the task" }],
		});
		expect(card.specConformanceDisclosure).toBe("");
	});

	it("discloses, but does not flag, members with no linked issue or an unresolved check", () => {
		const pr1 = makePR("pr-1");
		const pr2 = makePR("pr-2");
		const bundle = makeBundle([pr1, pr2]);
		const specResults = new Map<string, SpecConformanceResult>([["pr-1", { outcome: "inconclusive" }]]); // pr-2 missing entirely

		const card = buildReviewCard(bundle, new Map(), specResults);

		expect(card.specConformance).toEqual({ status: "clean" });
		expect(card.specConformanceDisclosure).toContain("2 of 2");
	});
});

describe("computeInputsHash — spec-conformance sensitivity", () => {
	it("changes when a member's declaredDirection changes, unlike drift's inputs", () => {
		const bundle = makeBundle([makePR("pr-1", { declaredDirection: "add passwordless auth" })]);
		const edited = makeBundle([makePR("pr-1", { declaredDirection: "refactor auth token storage" })]);

		expect(computeInputsHash(bundle)).not.toBe(computeInputsHash(edited));
	});

	it("changes when a member's linkedIssueNumber changes", () => {
		const bundle = makeBundle([makePR("pr-1", { linkedIssueNumber: 12 })]);
		const relinked = makeBundle([makePR("pr-1", { linkedIssueNumber: 13 })]);

		expect(computeInputsHash(bundle)).not.toBe(computeInputsHash(relinked));
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
			specConformance: { status: "clean" },
			specConformanceDisclosure: "",
			inputsHash: "hash-1",
			memberCount: 1,
		};
		const bundle = makeBundle([makePR("pr-1", { repoOwner: "acme", repoName: "widgets" })]);

		const card = reuseReviewCard(bundle, priorCard);

		expect(card.repoOwner).toBe("acme");
		expect(card.repoName).toBe("widgets");
	});
});
