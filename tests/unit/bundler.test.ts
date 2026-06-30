import { describe, it, expect } from "@jest/globals";
import { buildBundles } from "../../src/engine/bundle/bundler.js";
import { StubLlmProvider } from "../mocks/llmProvider.js";
import type { PullRequest } from "../../src/engine/types/core.js";

function makePR(id: string, direction: string, overrides: Partial<PullRequest> = {}): PullRequest {
	return {
		id, repoOwner: "org", repoName: "repo", number: 1,
		declaredDirection: direction,
		diff: { raw: "", hunks: [] },
		filesTouched: [`src/${id}.ts`],
		symbolsTouched: [], testNamesChanged: [], ciStatus: "success",
		...overrides,
	};
}

describe("buildBundles — clusters on drift-check evidence, not declaredDirection (INV-1)", () => {
	it("does not bundle PRs with the same declaredDirection but divergent extracted effects", async () => {
		const stub = new StubLlmProvider();
		// Extraction is blind to declaredDirection — both PRs declare the same direction,
		// but what they actually do (per extraction) has nothing in common.
		stub.queueCompletion(JSON.stringify(["adds OTP-based login flow"]));
		stub.queueCompletion(JSON.stringify(["migrates database connection pooling to a new ORM"]));

		const prs = [
			makePR("pr-a", "add passwordless auth"),
			makePR("pr-b", "add passwordless auth"),
		];

		const { bundles } = await buildBundles(prs, stub, { similarityThreshold: 0.75 });

		expect(bundles.length).toBe(2);
		const memberIds = bundles.map((b) => b.members.map((m) => m.id));
		expect(memberIds).not.toContainEqual(["pr-a", "pr-b"]);
	});

	it("bundles PRs with differing declaredDirection text when extracted effects agree", async () => {
		const stub = new StubLlmProvider();
		stub.queueCompletion(JSON.stringify(["adds OTP-based login flow to the auth endpoint"]));
		stub.queueCompletion(JSON.stringify(["adds OTP-based login flow to the auth endpoint"]));

		const prs = [
			makePR("pr-a", "add passwordless auth"),
			makePR("pr-b", "improve sign-in security"),
		];

		const { bundles } = await buildBundles(prs, stub, { similarityThreshold: 0.75 });

		expect(bundles.length).toBe(1);
		expect(bundles[0]?.members.map((m) => m.id)).toEqual(["pr-a", "pr-b"]);
	});

	it("returns the effects it extracted so callers can reuse them for the drift check", async () => {
		const stub = new StubLlmProvider();
		stub.queueCompletion(JSON.stringify(["adds OTP-based login flow"]));

		const prs = [makePR("pr-a", "add passwordless auth")];
		const { effectsByPr } = await buildBundles(prs, stub, { similarityThreshold: 0.75 });

		expect(effectsByPr.get("pr-a")).toEqual(["adds OTP-based login flow"]);
	});
});
