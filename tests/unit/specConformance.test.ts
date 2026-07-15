import { describe, it, expect } from "@jest/globals";
import { checkSpecConformance, type LinkedIssue } from "../../src/engine/specConformance/check.js";
import { StubLlmProvider } from "../mocks/llmProvider.js";
import { UNDECLARED_DIRECTION, type PullRequest } from "../../src/engine/types/core.js";

function makePR(overrides: Partial<PullRequest> = {}): PullRequest {
	return {
		id: "pr-1",
		repoOwner: "org",
		repoName: "repo",
		number: 1,
		headSha: "sha-1",
		declaredDirection: "add passwordless auth",
		directionInferred: false,
		diff: { raw: "", hunks: [] },
		filesTouched: ["src/auth.ts"],
		labels: [],
		assignees: [],
		symbolsTouched: [],
		testNamesChanged: [],
		ciStatus: "success",
		...overrides,
	};
}

const ISSUE: LinkedIssue = { number: 12, title: "Add passwordless auth", body: "Users should be able to log in via a magic link." };

describe("checkSpecConformance", () => {
	it("is inconclusive with no linked issue, and never calls the provider", async () => {
		const stub = new StubLlmProvider();
		const result = await checkSpecConformance(makePR(), undefined, stub);
		expect(result).toEqual({ outcome: "inconclusive" });
		expect(stub.calls).toHaveLength(0);
	});

	it("is inconclusive when the direction is inferred (not a real declaration), and never calls the provider", async () => {
		const stub = new StubLlmProvider();
		const result = await checkSpecConformance(
			makePR({ declaredDirection: UNDECLARED_DIRECTION, directionInferred: true }),
			ISSUE,
			stub,
		);
		expect(result).toEqual({ outcome: "inconclusive" });
		expect(stub.calls).toHaveLength(0);
	});

	it("returns clean when the model reports conformance", async () => {
		const stub = new StubLlmProvider();
		stub.queueCompletion('{"conforms": true, "explanation": null}');
		const result = await checkSpecConformance(makePR(), ISSUE, stub);
		expect(result).toEqual({ outcome: "clean" });
	});

	it("returns flagged with the model's explanation on a mismatch", async () => {
		const stub = new StubLlmProvider();
		stub.queueCompletion('{"conforms": false, "explanation": "issue asked for passwordless auth, PR declares it now adds a full admin dashboard"}');
		const result = await checkSpecConformance(
			makePR({ declaredDirection: "add an admin dashboard" }),
			ISSUE,
			stub,
		);
		expect(result).toEqual({
			outcome: "flagged",
			explanation: "issue asked for passwordless auth, PR declares it now adds a full admin dashboard",
		});
	});

	it("retries once on malformed JSON, then succeeds", async () => {
		const stub = new StubLlmProvider();
		stub.queueCompletion("not json");
		stub.queueCompletion('{"conforms": true, "explanation": null}');
		const result = await checkSpecConformance(makePR(), ISSUE, stub);
		expect(result).toEqual({ outcome: "clean" });
	});

	it("is inconclusive after exhausting retries on malformed JSON — never fabricates clean or flagged", async () => {
		const stub = new StubLlmProvider();
		stub.queueCompletion("not json");
		stub.queueCompletion("still not json");
		const result = await checkSpecConformance(makePR(), ISSUE, stub);
		expect(result).toEqual({ outcome: "inconclusive" });
	});
});
