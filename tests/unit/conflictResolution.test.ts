import { describe, it, expect } from "@jest/globals";
import { planFileResolutions, resolveMergeConflict } from "../../src/engine/queue/conflictResolution.js";
import { StubGitHubClient } from "../../src/engine/github/stubClient.js";
import type { PullRequest } from "../../src/engine/types/core.js";
import type { ConflictTrees, MergeabilityResult, TreeEntry } from "../../src/engine/types/mergeability.js";

const CALLBACK_BASE_URL = "https://quire.example.com/callbacks/action-resolution";

function makePr(overrides: Partial<PullRequest> = {}): PullRequest {
	return {
		id: "pr-1",
		repoOwner: "org",
		repoName: "repo",
		number: 1,
		headSha: "head-sha",
		declaredDirection: "add passwordless auth",
		diff: { raw: "", hunks: [] },
		filesTouched: ["src/auth.ts"],
		symbolsTouched: [],
		testNamesChanged: [],
		ciStatus: "success",
		...overrides,
	};
}

function makeMergeability(overrides: Partial<MergeabilityResult> = {}): MergeabilityResult {
	return {
		state: "dirty",
		isFork: false,
		merged: false,
		headBranch: "feature",
		headSha: "head-sha",
		baseBranch: "main",
		baseSha: "base-tip-sha",
		...overrides,
	};
}

function blob(sha: string, mode = "100644"): TreeEntry {
	return { type: "blob", mode, sha };
}

function submodule(sha: string): TreeEntry {
	return { type: "commit", mode: "160000", sha };
}

function trees(overrides: Partial<ConflictTrees> = {}): ConflictTrees {
	return {
		mergeBaseSha: "merge-base-commit",
		baseSha: "base-tip-commit",
		headSha: "head-commit",
		mergeBaseTree: new Map(),
		baseTree: new Map(),
		headTree: new Map(),
		...overrides,
	};
}

describe("planFileResolutions", () => {
	it("skips a file that's identical on both sides", () => {
		const t = trees({
			mergeBaseTree: new Map([["a.ts", blob("sha-1")]]),
			baseTree: new Map([["a.ts", blob("sha-1")]]),
			headTree: new Map([["a.ts", blob("sha-1")]]),
		});
		expect(planFileResolutions(t)).toEqual([]);
	});

	it("plans takeOurs when theirs didn't change the file from the merge base", () => {
		const t = trees({
			mergeBaseTree: new Map([["a.ts", blob("sha-base")]]),
			baseTree: new Map([["a.ts", blob("sha-base")]]),
			headTree: new Map([["a.ts", blob("sha-ours")]]),
		});
		expect(planFileResolutions(t)).toEqual([{ path: "a.ts", kind: "takeOurs" }]);
	});

	it("plans takeTheirs when ours didn't change the file from the merge base", () => {
		const t = trees({
			mergeBaseTree: new Map([["a.ts", blob("sha-base")]]),
			baseTree: new Map([["a.ts", blob("sha-theirs")]]),
			headTree: new Map([["a.ts", blob("sha-base")]]),
		});
		expect(planFileResolutions(t)).toEqual([{ path: "a.ts", kind: "takeTheirs", sha: "sha-theirs", mode: "100644" }]);
	});

	it("plans needsThreeWayMerge when both sides changed the file differently", () => {
		const t = trees({
			mergeBaseTree: new Map([["a.ts", blob("sha-base")]]),
			baseTree: new Map([["a.ts", blob("sha-theirs")]]),
			headTree: new Map([["a.ts", blob("sha-ours")]]),
		});
		expect(planFileResolutions(t)).toEqual([
			{ path: "a.ts", kind: "needsThreeWayMerge", mergeBaseSha: "sha-base", oursSha: "sha-ours", theirsSha: "sha-theirs", mode: "100644" },
		]);
	});

	it("plans needsThreeWayMerge (not structural) for a genuine add/add with no common ancestor", () => {
		const t = trees({
			mergeBaseTree: new Map(),
			baseTree: new Map([["a.ts", blob("sha-theirs")]]),
			headTree: new Map([["a.ts", blob("sha-ours")]]),
		});
		expect(planFileResolutions(t)).toEqual([
			{ path: "a.ts", kind: "needsThreeWayMerge", mergeBaseSha: undefined, oursSha: "sha-ours", theirsSha: "sha-theirs", mode: "100644" },
		]);
	});

	it("flags a submodule reference changed on both sides as structural", () => {
		const t = trees({
			mergeBaseTree: new Map([["vendor/lib", submodule("sha-base")]]),
			baseTree: new Map([["vendor/lib", submodule("sha-theirs")]]),
			headTree: new Map([["vendor/lib", submodule("sha-ours")]]),
		});
		const plans = planFileResolutions(t);
		expect(plans).toHaveLength(1);
		expect(plans[0]).toMatchObject({ path: "vendor/lib", kind: "structuralConflict" });
	});

	it("flags a file mode changed differently on each side as structural", () => {
		const t = trees({
			mergeBaseTree: new Map([["run.sh", blob("sha-base", "100644")]]),
			baseTree: new Map([["run.sh", blob("sha-theirs", "100644")]]),
			headTree: new Map([["run.sh", blob("sha-ours", "100755")]]),
		});
		const plans = planFileResolutions(t);
		expect(plans).toEqual([{ path: "run.sh", kind: "structuralConflict", reason: "file mode changed differently on each side" }]);
	});

	it("flags a modify/delete disagreement as structural", () => {
		const t = trees({
			mergeBaseTree: new Map([["a.ts", blob("sha-base")]]),
			baseTree: new Map([["a.ts", blob("sha-theirs")]]), // theirs modified it
			headTree: new Map(), // ours deleted it
		});
		const plans = planFileResolutions(t);
		expect(plans).toEqual([{ path: "a.ts", kind: "structuralConflict", reason: "modified on one side, deleted on the other" }]);
	});
});

describe("resolveMergeConflict", () => {
	function setUpConflict(github: StubGitHubClient, base: string, ours: string, theirs: string): void {
		github.setBlobContent("base-sha", base);
		github.setBlobContent("ours-sha", ours);
		github.setBlobContent("theirs-sha", theirs);
		github.setConflictTrees(
			"org",
			"repo",
			1,
			trees({
				mergeBaseTree: new Map([["src/auth.ts", blob("base-sha")]]),
				baseTree: new Map([["src/auth.ts", blob("theirs-sha")]]),
				headTree: new Map([["src/auth.ts", blob("ours-sha")]]),
			}),
		);
	}

	it("resolves non-overlapping changes via diff3 alone, without dispatching", async () => {
		const github = new StubGitHubClient();
		setUpConflict(github, "line1\nline2\nline3", "line1-ours\nline2\nline3", "line1\nline2\nline3-theirs");

		const result = await resolveMergeConflict("bundle-1", makePr(), makeMergeability(), github, CALLBACK_BASE_URL);

		expect(result).toEqual({ status: "resolved" });
		expect(github.dispatchConflictResolutionCalls).toHaveLength(0);
		expect(github.commitResolvedFilesCalls[0]?.files).toEqual([
			{ path: "src/auth.ts", content: "line1-ours\nline2\nline3-theirs", mode: "100644" },
		]);
	});

	it("dispatches to the target repo's conflict-resolution Action when diff3 can't auto-merge", async () => {
		const github = new StubGitHubClient();
		setUpConflict(github, "line1\nline2", "line1-ours\nline2", "line1-theirs\nline2");
		const pr = makePr();
		const mergeability = makeMergeability({ headBranch: "feature", baseBranch: "main" });

		const result = await resolveMergeConflict("bundle-1", pr, mergeability, github, CALLBACK_BASE_URL);

		expect(result.status).toBe("dispatched");
		if (result.status !== "dispatched") return;
		expect(result.prId).toBe(pr.id);
		expect(result.callbackToken).toMatch(/^[0-9a-f]{64}$/);
		expect(github.commitResolvedFilesCalls).toHaveLength(0);
		expect(github.dispatchConflictResolutionCalls).toEqual([
			{
				owner: "org",
				repo: "repo",
				params: {
					prNumber: 1,
					headBranch: "feature",
					baseBranch: "main",
					declaredDirection: "add passwordless auth",
					callbackUrl: `${CALLBACK_BASE_URL}/bundle-1/resolution`,
					callbackToken: result.callbackToken,
				},
			},
		]);
	});

	it("fails closed without dispatching when no callback URL is configured", async () => {
		const github = new StubGitHubClient();
		setUpConflict(github, "line1\nline2", "line1-ours\nline2", "line1-theirs\nline2");

		const result = await resolveMergeConflict("bundle-1", makePr(), makeMergeability(), github, undefined);

		expect(result).toEqual({
			status: "failed",
			reason: "QUIRE_PUBLIC_URL is not configured — the conflict-resolution Action has no way to call back to this instance",
		});
		expect(github.dispatchConflictResolutionCalls).toHaveLength(0);
	});

	it("fails closed when the dispatch call itself throws", async () => {
		const github = new StubGitHubClient();
		setUpConflict(github, "line1\nline2", "line1-ours\nline2", "line1-theirs\nline2");
		github.dispatchConflictResolutionError = new Error("workflow not found on default branch");

		const result = await resolveMergeConflict("bundle-1", makePr(), makeMergeability(), github, CALLBACK_BASE_URL);

		expect(result.status).toBe("failed");
		if (result.status === "failed") {
			expect(result.reason).toContain("could not dispatch the conflict-resolution workflow");
			expect(result.reason).toContain("workflow not found on default branch");
		}
	});

	it("bails without dispatching when the head branch lives in a fork", async () => {
		const github = new StubGitHubClient();
		const result = await resolveMergeConflict("bundle-1", makePr(), makeMergeability({ isFork: true }), github, CALLBACK_BASE_URL);

		expect(result).toEqual({ status: "failed", reason: "head branch lives in a fork this installation can't push to" });
		expect(github.dispatchConflictResolutionCalls).toHaveLength(0);
	});
});
