import { describe, it, expect, afterEach } from "@jest/globals";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MergeQueue } from "../../src/engine/queue/mergeQueue.js";
import { StubGitHubClient } from "../../src/engine/github/stubClient.js";
import { StubLlmProvider } from "../../src/engine/drift/effectList/stubProvider.js";
import { LlmProviderHolder } from "../../src/engine/drift/effectList/providerHolder.js";
import type { Bundle, PullRequest, ReviewCard } from "../../src/engine/types/core.js";
import type { ConflictTrees, MergeabilityResult, TreeEntry } from "../../src/engine/types/mergeability.js";

// Fresh holder per call site — resolution attempts within a test share a queue but each
// MergeQueue construction below wants its own isolated provider/queue of stub completions.
function llmHolder(provider: StubLlmProvider = new StubLlmProvider()): LlmProviderHolder {
	return new LlmProviderHolder(provider);
}

function makeBundle(id: string, members: ReadonlyArray<PullRequest> = []): Bundle {
	return {
		id,
		direction: "add passwordless auth",
		effectSummary: "adds OTP-based login",
		members,
	};
}

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
		state: "clean",
		isFork: false,
		merged: false,
		headBranch: "feature",
		headSha: "head-sha",
		baseBranch: "main",
		baseSha: "base-sha",
		...overrides,
	};
}

function entry(sha: string, mode = "100644"): TreeEntry {
	return { type: "blob", mode, sha };
}

// A conflict on a single file: base had "base", ours changed it to "ours", theirs changed
// it to "theirs" — a genuine three-way divergence needing either diff3 or the Action.
function makeConflictTrees(path: string, baseSha: string, oursSha: string, theirsSha: string): ConflictTrees {
	return {
		mergeBaseSha: "merge-base-sha",
		baseSha: "base-tip-sha",
		headSha: "head-sha",
		mergeBaseTree: new Map([[path, entry(baseSha)]]),
		baseTree: new Map([[path, entry(theirsSha)]]),
		headTree: new Map([[path, entry(oursSha)]]),
	};
}

function makeCard(bundleId: string): ReviewCard {
	return {
		bundleId,
		directionSummary: "add passwordless auth",
		blastRadius: 1,
		flags: [],
		drift: { status: "clean" },
		residualDisclosure: "behavioral confirm not run",
		inputsHash: "hash-1",
		memberCount: 0,
	};
}

describe("MergeQueue.clear", () => {
	let dir: string;

	afterEach(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	it("empties in-memory entries and persists the empty state to disk", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-queue-"));
		const statePath = join(dir, "queue.json");
		const queue = new MergeQueue(statePath, new StubGitHubClient(), llmHolder(), join(dir, "conflict.ndjson"));
		await queue.load();

		await queue.enqueue(makeBundle("bundle-1"));
		expect(await queue.listEntries()).toHaveLength(1);

		await queue.clear();
		expect(await queue.listEntries()).toHaveLength(0);

		const persisted = JSON.parse(await readFile(statePath, "utf8"));
		expect(persisted.entries).toEqual([]);
	});
});

describe("MergeQueue.removeQueued", () => {
	let dir: string;

	afterEach(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	it("removes an entry that is still queued", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-queue-"));
		const statePath = join(dir, "queue.json");
		const queue = new MergeQueue(statePath, new StubGitHubClient(), llmHolder(), join(dir, "conflict.ndjson"));
		await queue.load();

		await queue.enqueue(makeBundle("bundle-1"));
		const removed = await queue.removeQueued("bundle-1");

		expect(removed).toMatchObject({ bundleId: "bundle-1", status: "queued" });
		expect(await queue.listEntries()).toHaveLength(0);
		const persisted = JSON.parse(await readFile(statePath, "utf8"));
		expect(persisted.entries).toEqual([]);
	});

	it("does not remove an entry that has started landing", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-queue-"));
		const statePath = join(dir, "queue.json");
		const queue = new MergeQueue(statePath, new StubGitHubClient(), llmHolder(), join(dir, "conflict.ndjson"));
		await queue.load();

		await queue.enqueue(makeBundle("bundle-1"));
		await queue.dequeueNext(); // lands bundle-1 (StubGitHubClient merges are no-ops)

		const removed = await queue.removeQueued("bundle-1");

		expect(removed).toBeUndefined();
		expect(await queue.listEntries()).toHaveLength(1);
	});

	it("silently no-ops when the bundle is not in the queue", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-queue-"));
		const statePath = join(dir, "queue.json");
		const queue = new MergeQueue(statePath, new StubGitHubClient(), llmHolder(), join(dir, "conflict.ndjson"));
		await queue.load();

		await expect(queue.removeQueued("missing-bundle")).resolves.toBeUndefined();
	});

	it("carries the card through so a later removal can restore it", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-queue-"));
		const statePath = join(dir, "queue.json");
		const queue = new MergeQueue(statePath, new StubGitHubClient(), llmHolder(), join(dir, "conflict.ndjson"));
		await queue.load();

		await queue.enqueue(makeBundle("bundle-1"), makeCard("bundle-1"));
		const removed = await queue.removeQueued("bundle-1");

		expect(removed?.card).toEqual(makeCard("bundle-1"));
	});

	it("leaves the card undefined when none was provided at enqueue (legacy compatibility)", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-queue-"));
		const statePath = join(dir, "queue.json");
		const queue = new MergeQueue(statePath, new StubGitHubClient(), llmHolder(), join(dir, "conflict.ndjson"));
		await queue.load();

		await queue.enqueue(makeBundle("bundle-1"));
		const removed = await queue.removeQueued("bundle-1");

		expect(removed?.card).toBeUndefined();
	});
});

describe("MergeQueue.dequeueNext — mergeability handling", () => {
	let dir: string;

	afterEach(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	async function setup(): Promise<{ github: StubGitHubClient; queue: MergeQueue }> {
		dir = await mkdtemp(join(tmpdir(), "quire-queue-"));
		const github = new StubGitHubClient();
		const queue = new MergeQueue(join(dir, "queue.json"), github, llmHolder(), join(dir, "conflict.ndjson"));
		await queue.load();
		return { github, queue };
	}

	it("merges normally when mergeability is clean", async () => {
		const { github, queue } = await setup();
		const pr = makePr();
		await queue.enqueue(makeBundle("bundle-1", [pr]));

		const landed = await queue.dequeueNext();

		expect(landed?.status).toBe("landed");
		expect(github.mergedPrs).toEqual(["org/repo/1"]);
	});

	it("updates the branch and lands when behind", async () => {
		const { github, queue } = await setup();
		const pr = makePr();
		github.setMergeability(pr.repoOwner, pr.repoName, pr.number, makeMergeability({ state: "behind" }));
		await queue.enqueue(makeBundle("bundle-1", [pr]));

		const landed = await queue.dequeueNext();

		expect(landed?.status).toBe("landed");
		expect(github.updateBranchCalls).toEqual(["org/repo/1"]);
		expect(github.mergedPrs).toEqual(["org/repo/1"]);
	});

	it("resolves non-overlapping edits via diff3 alone and lands", async () => {
		const { github, queue } = await setup();
		const pr = makePr();
		const base = "line1\nline2\nline3\nline4\nline5";
		const ours = "line1-ours\nline2\nline3\nline4\nline5"; // only the first line changed
		const theirs = "line1\nline2\nline3\nline4\nline5-theirs"; // only the last line changed
		github.setBlobContent("base-sha", base);
		github.setBlobContent("ours-sha", ours);
		github.setBlobContent("theirs-sha", theirs);
		github.setConflictTrees(pr.repoOwner, pr.repoName, pr.number, makeConflictTrees("src/auth.ts", "base-sha", "ours-sha", "theirs-sha"));
		github.setMergeability(pr.repoOwner, pr.repoName, pr.number, makeMergeability({ state: "dirty" }));
		await queue.enqueue(makeBundle("bundle-1", [pr]));

		const landed = await queue.dequeueNext();

		expect(landed?.status).toBe("landed");
		expect(github.mergedPrs).toEqual(["org/repo/1"]);
		expect(github.commitResolvedFilesCalls).toHaveLength(1);
		expect(github.commitResolvedFilesCalls[0]?.files).toEqual([
			{ path: "src/auth.ts", content: "line1-ours\nline2\nline3\nline4\nline5-theirs", mode: "100644" },
		]);
	});

	it("marks the bundle as conflicted when diff3 can't auto-merge and the model isn't confident", async () => {
		const { github, queue } = await setup();
		const pr = makePr();
		const base = "line1\nline2";
		const ours = "line1-ours\nline2"; // both sides changed the same line
		const theirs = "line1-theirs\nline2";
		github.setBlobContent("base-sha", base);
		github.setBlobContent("ours-sha", ours);
		github.setBlobContent("theirs-sha", theirs);
		github.setConflictTrees(pr.repoOwner, pr.repoName, pr.number, makeConflictTrees("src/auth.ts", "base-sha", "ours-sha", "theirs-sha"));
		github.setMergeability(pr.repoOwner, pr.repoName, pr.number, makeMergeability({ state: "dirty" }));
		await queue.enqueue(makeBundle("bundle-1", [pr]));

		// No completion queued on the stub provider — defaults to "[]", so the hunk gets no
		// judgment and fails closed to low confidence.
		const blocked = await queue.dequeueNext();

		expect(blocked?.status).toBe("conflict");
		expect(blocked?.conflict?.reason).toContain("could not confidently resolve 1 conflicting hunk");
		expect(github.mergedPrs).toEqual([]);
		expect(github.commitResolvedFilesCalls).toHaveLength(0);
	});

	it("marks the bundle as conflicted when blocked by branch protection", async () => {
		const { github, queue } = await setup();
		const pr = makePr();
		github.setMergeability(pr.repoOwner, pr.repoName, pr.number, makeMergeability({ state: "blocked" }));
		await queue.enqueue(makeBundle("bundle-1", [pr]));

		const blocked = await queue.dequeueNext();

		expect(blocked?.status).toBe("conflict");
		expect(blocked?.conflict?.reason).toContain("branch protection");
		expect(github.mergedPrs).toEqual([]);
	});

	it("marks the bundle as conflicted when checks are unstable", async () => {
		const { github, queue } = await setup();
		const pr = makePr();
		github.setMergeability(pr.repoOwner, pr.repoName, pr.number, makeMergeability({ state: "unstable" }));
		await queue.enqueue(makeBundle("bundle-1", [pr]));

		const blocked = await queue.dequeueNext();

		expect(blocked?.status).toBe("conflict");
		expect(blocked?.conflict?.reason).toContain("status checks");
	});

	it("bails to conflict without attempting a write when the PR head lives in a fork", async () => {
		const { github, queue } = await setup();
		const pr = makePr();
		github.setMergeability(pr.repoOwner, pr.repoName, pr.number, makeMergeability({ state: "behind", isFork: true }));
		await queue.enqueue(makeBundle("bundle-1", [pr]));

		const blocked = await queue.dequeueNext();

		expect(blocked?.status).toBe("conflict");
		expect(blocked?.conflict?.reason).toContain("fork");
		expect(github.updateBranchCalls).toEqual([]);
	});

	it("lands a PR GitHub already reports as merged, without calling mergePullRequest again", async () => {
		// Simulates a prior dequeueNext() attempt that merged the PR on GitHub but crashed
		// before persisting mergedPrIds — GitHub reports mergeable_state "unknown" forever
		// for a merged PR, so without the `merged` short-circuit this would poll out to a
		// timeout and get misreported as a conflict (see the next test).
		const { github, queue } = await setup();
		const pr = makePr();
		github.setMergeability(pr.repoOwner, pr.repoName, pr.number, makeMergeability({ state: "unknownPending", merged: true }));
		await queue.enqueue(makeBundle("bundle-1", [pr]));

		const landed = await queue.dequeueNext();

		expect(landed?.status).toBe("landed");
		expect(landed?.mergedPrIds).toEqual([pr.id]);
		expect(github.mergedPrs).toEqual([]);
	});

	it("bails to conflict when GitHub never finishes computing mergeability", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-queue-"));
		const github = new StubGitHubClient();
		// Empty poll-delay list: still polls once per entry with a zero-length backoff
		// schedule, so the test resolves near-instantly instead of waiting on real timers.
		const queue = new MergeQueue(join(dir, "queue.json"), github, llmHolder(), join(dir, "conflict.ndjson"), [0, 0]);
		await queue.load();
		const pr = makePr();
		github.setMergeability(pr.repoOwner, pr.repoName, pr.number, makeMergeability({ state: "unknownPending" }));
		await queue.enqueue(makeBundle("bundle-1", [pr]));

		const blocked = await queue.dequeueNext();

		expect(blocked?.status).toBe("conflict");
		expect(blocked?.conflict?.reason).toContain("did not finish computing");
	});
});

describe("MergeQueue concurrency", () => {
	let dir: string;

	afterEach(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	// Two independent triggers (e.g. a manual "Process" click and autoMergeOnAccept) can call
	// dequeueNext() back to back. Without serialization, the second call can pick up the first
	// bundle while it's still "landing" (the status dequeueNext itself just set, synchronously,
	// before its first await) instead of moving on to the next queued bundle — both then race
	// on the same bundle's members instead of one call handling each bundle in turn.
	it("serializes overlapping dequeueNext calls so each queued bundle is landed exactly once", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-queue-"));
		const github = new StubGitHubClient();
		const queue = new MergeQueue(join(dir, "queue.json"), github, llmHolder(), join(dir, "conflict.ndjson"));
		await queue.load();

		const prA = makePr({ id: "pr-a", number: 1 });
		const prB = makePr({ id: "pr-b", number: 2 });
		await queue.enqueue(makeBundle("bundle-a", [prA]));
		await queue.enqueue(makeBundle("bundle-b", [prB]));

		const results = await Promise.all([queue.dequeueNext(), queue.dequeueNext()]);

		expect(results.map((r) => r?.bundleId).sort()).toEqual(["bundle-a", "bundle-b"]);
		expect(results.every((r) => r?.status === "landed")).toBe(true);
		expect(github.mergedPrs.sort()).toEqual(["org/repo/1", "org/repo/2"]);
	});
});

describe("MergeQueue.reattempt", () => {
	let dir: string;

	afterEach(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	it("returns undefined when the bundle isn't in a conflict or aborted state", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-queue-"));
		const queue = new MergeQueue(join(dir, "queue.json"), new StubGitHubClient(), llmHolder(), join(dir, "conflict.ndjson"));
		await queue.load();
		await queue.enqueue(makeBundle("bundle-1"));

		await expect(queue.reattempt("bundle-1")).resolves.toBeUndefined();
	});

	it("clears the conflict and requeues, so a later dequeueNext can land it", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-queue-"));
		const github = new StubGitHubClient();
		const queue = new MergeQueue(join(dir, "queue.json"), github, llmHolder(), join(dir, "conflict.ndjson"));
		await queue.load();
		const pr = makePr();
		github.setMergeability(pr.repoOwner, pr.repoName, pr.number, makeMergeability({ state: "blocked" }));
		await queue.enqueue(makeBundle("bundle-1", [pr]));
		const blocked = await queue.dequeueNext();
		expect(blocked?.status).toBe("conflict");

		// The human fixes the branch-protection issue on GitHub, then retries.
		github.setMergeability(pr.repoOwner, pr.repoName, pr.number, makeMergeability({ state: "clean" }));
		const retried = await queue.reattempt("bundle-1");
		expect(retried?.status).toBe("queued");
		expect(retried?.conflict).toBeUndefined();

		const landed = await queue.dequeueNext();
		expect(landed?.status).toBe("landed");
		expect(github.mergedPrs).toEqual(["org/repo/1"]);
	});

	it("clears abortedAt and requeues an aborted bundle, resuming from its partial merge progress", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-queue-"));
		const github = new StubGitHubClient();
		const queue = new MergeQueue(join(dir, "queue.json"), github, llmHolder(), join(dir, "conflict.ndjson"));
		await queue.load();
		const pr1 = makePr({ id: "pr-1", number: 1 });
		const pr2 = makePr({ id: "pr-2", number: 2 });
		github.setMergeability(pr2.repoOwner, pr2.repoName, pr2.number, makeMergeability({ state: "blocked" }));
		await queue.enqueue(makeBundle("bundle-1", [pr1, pr2]));
		await queue.dequeueNext(); // merges pr1, blocks on pr2 with status "conflict"
		await queue.abort("bundle-1");

		github.setMergeability(pr2.repoOwner, pr2.repoName, pr2.number, makeMergeability({ state: "clean" }));
		const retried = await queue.reattempt("bundle-1");
		expect(retried?.status).toBe("queued");
		expect(retried?.abortedAt).toBeUndefined();
		expect(retried?.mergedPrIds).toEqual([pr1.id]);

		const landed = await queue.dequeueNext();
		expect(landed?.status).toBe("landed");
		// pr1 was merged before the abort; pr2 merges now — pr1 is never re-merged.
		expect(github.mergedPrs).toEqual(["org/repo/1", "org/repo/2"]);
	});
});

describe("MergeQueue.abort", () => {
	let dir: string;

	afterEach(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	async function setup(): Promise<{ github: StubGitHubClient; queue: MergeQueue }> {
		dir = await mkdtemp(join(tmpdir(), "quire-queue-"));
		const github = new StubGitHubClient();
		const queue = new MergeQueue(join(dir, "queue.json"), github, llmHolder(), join(dir, "conflict.ndjson"));
		await queue.load();
		return { github, queue };
	}

	it("aborts a bundle stuck in conflict, clearing the conflict reason", async () => {
		const { github, queue } = await setup();
		const pr = makePr();
		github.setMergeability(pr.repoOwner, pr.repoName, pr.number, makeMergeability({ state: "blocked" }));
		await queue.enqueue(makeBundle("bundle-1", [pr]));
		const blocked = await queue.dequeueNext();
		expect(blocked?.status).toBe("conflict");

		const aborted = await queue.abort("bundle-1");

		expect(aborted?.status).toBe("aborted");
		expect(aborted?.conflict).toBeUndefined();
		expect(aborted?.abortedAt).toEqual(expect.any(String));
	});

	it("preserves mergedPrIds on abort so the partial-merge residual stays visible", async () => {
		const { github, queue } = await setup();
		const pr1 = makePr({ id: "pr-1", number: 1 });
		const pr2 = makePr({ id: "pr-2", number: 2 });
		github.setMergeability(pr2.repoOwner, pr2.repoName, pr2.number, makeMergeability({ state: "blocked" }));
		await queue.enqueue(makeBundle("bundle-1", [pr1, pr2]));
		const blocked = await queue.dequeueNext();
		expect(blocked?.status).toBe("conflict");
		expect(blocked?.mergedPrIds).toEqual([pr1.id]);

		const aborted = await queue.abort("bundle-1");

		expect(aborted?.status).toBe("aborted");
		expect(aborted?.mergedPrIds).toEqual([pr1.id]);
	});

	it("returns undefined for a queued bundle (use removeQueued instead)", async () => {
		const { queue } = await setup();
		await queue.enqueue(makeBundle("bundle-1"));

		await expect(queue.abort("bundle-1")).resolves.toBeUndefined();
		expect((await queue.getEntry("bundle-1"))?.status).toBe("queued");
	});

	it("returns undefined for a landed bundle", async () => {
		const { queue } = await setup();
		await queue.enqueue(makeBundle("bundle-1", [makePr()]));
		await queue.dequeueNext();

		await expect(queue.abort("bundle-1")).resolves.toBeUndefined();
		expect((await queue.getEntry("bundle-1"))?.status).toBe("landed");
	});

	it("returns undefined for an already-aborted bundle", async () => {
		const { github, queue } = await setup();
		const pr = makePr();
		github.setMergeability(pr.repoOwner, pr.repoName, pr.number, makeMergeability({ state: "blocked" }));
		await queue.enqueue(makeBundle("bundle-1", [pr]));
		await queue.dequeueNext();
		await queue.abort("bundle-1");

		await expect(queue.abort("bundle-1")).resolves.toBeUndefined();
	});

	it("silently no-ops when the bundle is not in the queue", async () => {
		const { queue } = await setup();

		await expect(queue.abort("missing-bundle")).resolves.toBeUndefined();
	});
});

describe("MergeQueue.revertPr", () => {
	let dir: string;

	afterEach(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	async function setup(): Promise<{ github: StubGitHubClient; queue: MergeQueue }> {
		dir = await mkdtemp(join(tmpdir(), "quire-queue-"));
		const github = new StubGitHubClient();
		const queue = new MergeQueue(join(dir, "queue.json"), github, llmHolder(), join(dir, "conflict.ndjson"));
		await queue.load();
		return { github, queue };
	}

	it("reverts a PR from a fully landed bundle", async () => {
		const { queue } = await setup();
		const pr = makePr();
		await queue.enqueue(makeBundle("bundle-1", [pr]));
		await queue.dequeueNext();

		const revertUrl = await queue.revertPr("bundle-1", pr.id);

		expect(revertUrl).toEqual(expect.any(String));
		expect((await queue.getEntry("bundle-1"))?.revertedPrIds).toEqual([pr.id]);
	});

	it("reverts a PR that merged before the bundle was aborted", async () => {
		const { github, queue } = await setup();
		const pr1 = makePr({ id: "pr-1", number: 1 });
		const pr2 = makePr({ id: "pr-2", number: 2 });
		github.setMergeability(pr2.repoOwner, pr2.repoName, pr2.number, makeMergeability({ state: "blocked" }));
		await queue.enqueue(makeBundle("bundle-1", [pr1, pr2]));
		await queue.dequeueNext();
		await queue.abort("bundle-1");

		const revertUrl = await queue.revertPr("bundle-1", pr1.id);

		expect(revertUrl).toEqual(expect.any(String));
		expect((await queue.getEntry("bundle-1"))?.revertedPrIds).toEqual([pr1.id]);
	});

	it("rejects reverting a PR that was never merged", async () => {
		const { github, queue } = await setup();
		const pr = makePr();
		github.setMergeability(pr.repoOwner, pr.repoName, pr.number, makeMergeability({ state: "blocked" }));
		await queue.enqueue(makeBundle("bundle-1", [pr]));
		await queue.dequeueNext();

		await expect(queue.revertPr("bundle-1", pr.id)).rejects.toThrow(/was not merged/);
	});

	it("rejects reverting for a bundle not in the queue", async () => {
		const { queue } = await setup();

		await expect(queue.revertPr("missing-bundle", "pr-1")).rejects.toThrow(/not found in queue/);
	});
});

describe("MergeQueue.refreshQueuedBranches", () => {
	let dir: string;

	afterEach(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	it("fast-forwards a queued PR that has fallen behind main", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-queue-"));
		const github = new StubGitHubClient();
		const queue = new MergeQueue(join(dir, "queue.json"), github, llmHolder(), join(dir, "conflict.ndjson"));
		await queue.load();
		const pr = makePr();
		github.setMergeability(pr.repoOwner, pr.repoName, pr.number, makeMergeability({ state: "behind" }));
		await queue.enqueue(makeBundle("bundle-1", [pr]));

		await queue.refreshQueuedBranches();

		expect(github.updateBranchCalls).toEqual(["org/repo/1"]);
	});

	it("leaves already-mergeable, forked, and merged PRs alone", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-queue-"));
		const github = new StubGitHubClient();
		const queue = new MergeQueue(join(dir, "queue.json"), github, llmHolder(), join(dir, "conflict.ndjson"));
		await queue.load();
		const clean = makePr({ id: "pr-clean", number: 1 });
		const forkedBehind = makePr({ id: "pr-forked", number: 2, repoName: "repo2" });
		const alreadyMerged = makePr({ id: "pr-merged", number: 3, repoName: "repo3" });
		github.setMergeability(clean.repoOwner, clean.repoName, clean.number, makeMergeability({ state: "clean" }));
		github.setMergeability(forkedBehind.repoOwner, forkedBehind.repoName, forkedBehind.number, makeMergeability({ state: "behind", isFork: true }));
		github.setMergeability(alreadyMerged.repoOwner, alreadyMerged.repoName, alreadyMerged.number, makeMergeability({ state: "behind", merged: true }));
		await queue.enqueue(makeBundle("bundle-1", [clean, forkedBehind, alreadyMerged]));

		await queue.refreshQueuedBranches();

		expect(github.updateBranchCalls).toEqual([]);
	});

	it("does not touch PRs in bundles that aren't queued (already landing/conflict)", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-queue-"));
		const github = new StubGitHubClient();
		const queue = new MergeQueue(join(dir, "queue.json"), github, llmHolder(), join(dir, "conflict.ndjson"));
		await queue.load();
		const pr = makePr();
		github.setMergeability(pr.repoOwner, pr.repoName, pr.number, makeMergeability({ state: "blocked" }));
		await queue.enqueue(makeBundle("bundle-1", [pr]));
		await queue.dequeueNext(); // moves bundle-1 to "conflict"

		// Now that it's no longer "queued", flipping its mergeability to "behind" shouldn't
		// matter — refreshQueuedBranches only looks at entries still waiting their turn.
		github.setMergeability(pr.repoOwner, pr.repoName, pr.number, makeMergeability({ state: "behind" }));
		await queue.refreshQueuedBranches();

		expect(github.updateBranchCalls).toEqual([]);
	});

	it("keeps going past a PR whose refresh throws, so one failure doesn't block the rest", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-queue-"));
		const github = new StubGitHubClient();
		const queue = new MergeQueue(join(dir, "queue.json"), github, llmHolder(), join(dir, "conflict.ndjson"));
		await queue.load();
		const failing = makePr({ id: "pr-failing", number: 1 });
		const succeeding = makePr({ id: "pr-succeeding", number: 2, repoName: "repo2" });
		github.setMergeability(failing.repoOwner, failing.repoName, failing.number, makeMergeability({ state: "behind" }));
		github.setMergeability(succeeding.repoOwner, succeeding.repoName, succeeding.number, makeMergeability({ state: "behind" }));
		github.updateBranchError = new Error("network blip");
		await queue.enqueue(makeBundle("bundle-1", [failing, succeeding]));

		await expect(queue.refreshQueuedBranches()).resolves.toBeUndefined();

		expect(github.updateBranchCalls).toEqual(["org/repo/1", "org/repo2/2"]);
	});
});
