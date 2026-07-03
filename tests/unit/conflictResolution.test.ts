import { describe, it, expect } from "@jest/globals";
import { planFileResolutions, resolveMergeConflict } from "../../src/engine/queue/conflictResolution.js";
import { StubGitHubClient } from "../../src/engine/github/stubClient.js";
import { StubLlmProvider } from "../../src/engine/drift/effectList/stubProvider.js";
import type { PullRequest } from "../../src/engine/types/core.js";
import type { ConflictTrees, MergeabilityResult, TreeEntry } from "../../src/engine/types/mergeability.js";

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

	it("resolves non-overlapping changes via diff3 alone", async () => {
		const github = new StubGitHubClient();
		setUpConflict(github, "line1\nline2\nline3", "line1-ours\nline2\nline3", "line1\nline2\nline3-theirs");
		const provider = new StubLlmProvider();

		const result = await resolveMergeConflict(makePr(), makeMergeability(), github, provider);

		expect(result).toEqual({ status: "resolved" });
		expect(provider.calls).toHaveLength(0);
		expect(github.commitResolvedFilesCalls[0]?.files).toEqual([
			{ path: "src/auth.ts", content: "line1-ours\nline2\nline3-theirs", mode: "100644" },
		]);
	});

	it("resolves a mechanical hunk (whitespace-only divergence) without any LLM call", async () => {
		const github = new StubGitHubClient();
		setUpConflict(github, "line1\nline2\nline3", "line1\nline2-ours\nline3", "line1\nline2-ours \nline3");
		const provider = new StubLlmProvider();

		const result = await resolveMergeConflict(makePr(), makeMergeability(), github, provider);

		expect(result).toEqual({ status: "resolved" });
		expect(provider.calls).toHaveLength(0);
		expect(github.commitResolvedFilesCalls[0]?.files).toEqual([
			{ path: "src/auth.ts", content: "line1\nline2-ours\nline3", mode: "100644" },
		]);
	});

	it("resolves a semantic hunk via one batched LLM call at high confidence", async () => {
		const github = new StubGitHubClient();
		setUpConflict(github, "line1\nline2\nline3", "line1\nline2-A\nline3", "line1\nline2-B\nline3");
		const provider = new StubLlmProvider();
		provider.queueCompletion(JSON.stringify([{ hunk_id: 1, resolution: "line2-merged", confidence: "high" }]));

		const result = await resolveMergeConflict(makePr(), makeMergeability(), github, provider);

		expect(result).toEqual({ status: "resolved" });
		expect(provider.calls).toHaveLength(1);
		expect(github.commitResolvedFilesCalls[0]?.files).toEqual([
			{ path: "src/auth.ts", content: "line1\nline2-merged\nline3", mode: "100644" },
		]);
	});

	it("fails closed to the human queue when a semantic hunk resolves at low confidence", async () => {
		const github = new StubGitHubClient();
		setUpConflict(github, "line1\nline2\nline3", "line1\nline2-A\nline3", "line1\nline2-B\nline3");
		const provider = new StubLlmProvider();
		provider.queueCompletion(JSON.stringify([{ hunk_id: 1, resolution: "line2-merged", confidence: "low" }]));

		const result = await resolveMergeConflict(makePr(), makeMergeability(), github, provider);

		expect(result.status).toBe("failed");
		if (result.status === "failed") {
			expect(result.reason).toContain("could not confidently resolve a conflicting hunk");
		}
		expect(github.commitResolvedFilesCalls).toHaveLength(0);
	});

	it("bails when the head branch lives in a fork", async () => {
		const github = new StubGitHubClient();
		const provider = new StubLlmProvider();
		const result = await resolveMergeConflict(makePr(), makeMergeability({ isFork: true }), github, provider);

		expect(result).toEqual({ status: "failed", reason: "head branch lives in a fork this installation can't push to" });
		expect(provider.calls).toHaveLength(0);
	});
});
