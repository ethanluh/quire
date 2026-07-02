import { describe, it, expect, jest } from "@jest/globals";
import { planFileResolutions, resolveConflictedFile } from "../../src/engine/queue/conflictResolution.js";
import { StubLlmProvider } from "../mocks/llmProvider.js";
import type { ConflictTrees, TreeEntry } from "../../src/engine/types/mergeability.js";

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

describe("resolveConflictedFile", () => {
	it("resolves non-overlapping changes via diff3 alone, without calling the LLM", async () => {
		const provider = new StubLlmProvider();
		const base = "line1\nline2\nline3";
		const ours = "line1-ours\nline2\nline3";
		const theirs = "line1\nline2\nline3-theirs";

		const result = await resolveConflictedFile("a.ts", base, ours, theirs, "add passwordless auth", provider);

		expect(result).toEqual({ status: "resolved", content: "line1-ours\nline2\nline3-theirs" });
		expect(provider.calls).toHaveLength(0);
	});

	it("calls the LLM when diff3 can't auto-merge, and applies its fenced response", async () => {
		const provider = new StubLlmProvider();
		provider.queueCompletion("Here you go:\n```\nline1-merged\nline2\n```");
		const base = "line1\nline2";
		const ours = "line1-ours\nline2";
		const theirs = "line1-theirs\nline2";

		const result = await resolveConflictedFile("a.ts", base, ours, theirs, "add passwordless auth", provider);

		expect(result).toEqual({ status: "resolved", content: "line1-merged\nline2" });
		expect(provider.calls).toHaveLength(1);
	});

	it("fails closed when the model declines with UNRESOLVED", async () => {
		const provider = new StubLlmProvider();
		provider.queueCompletion("UNRESOLVED");
		const base = "line1\nline2";
		const ours = "line1-ours\nline2";
		const theirs = "line1-theirs\nline2";

		const result = await resolveConflictedFile("a.ts", base, ours, theirs, "add passwordless auth", provider);

		expect(result.status).toBe("unresolved");
		if (result.status === "unresolved") expect(result.reason).toContain("declined");
	});

	it("fails closed when the model's own output still contains conflict-marker lines", async () => {
		const provider = new StubLlmProvider();
		provider.queueCompletion("```\n<<<<<<< PR (ours)\nline1-ours\n=======\nline1-theirs\n>>>>>>> main (theirs)\nline2\n```");
		const base = "line1\nline2";
		const ours = "line1-ours\nline2";
		const theirs = "line1-theirs\nline2";

		const result = await resolveConflictedFile("a.ts", base, ours, theirs, "add passwordless auth", provider);

		expect(result.status).toBe("unresolved");
		if (result.status === "unresolved") expect(result.reason).toContain("conflict markers");
	});

	it("does not false-positive on a legitimate `=======` divider line when diff3 already resolved cleanly", async () => {
		const provider = new StubLlmProvider();
		const base = "a\nb";
		const ours = "a\n=======\nb"; // ours added a literal 7-equals divider line, no overlap with theirs
		const theirs = "a\nb-theirs";

		const result = await resolveConflictedFile("a.ts", base, ours, theirs, "add passwordless auth", provider);

		// diff3 merges cleanly (no LLM involved) — the marker-line check only ever runs on
		// content diff3 itself flagged as conflicted, so a clean merge is unaffected by it.
		expect(result.status).toBe("resolved");
		expect(provider.calls).toHaveLength(0);
	});

	it("fails closed when the LLM call itself throws", async () => {
		const provider = new StubLlmProvider();
		jest.spyOn(provider, "complete").mockRejectedValueOnce(new Error("rate limited"));
		const base = "line1\nline2";
		const ours = "line1-ours\nline2";
		const theirs = "line1-theirs\nline2";

		const result = await resolveConflictedFile("a.ts", base, ours, theirs, "add passwordless auth", provider);

		expect(result.status).toBe("unresolved");
		if (result.status === "unresolved") expect(result.reason).toContain("LLM call failed");
	});
});
