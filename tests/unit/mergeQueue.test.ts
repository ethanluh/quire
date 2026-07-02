import { describe, it, expect, afterEach } from "@jest/globals";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MergeQueue } from "../../src/engine/queue/mergeQueue.js";
import { StubGitHubClient } from "../../src/engine/github/stubClient.js";
import type { Bundle, PullRequest, ReviewCard } from "../../src/engine/types/core.js";
import type { ConflictTrees, MergeabilityResult, TreeEntry } from "../../src/engine/types/mergeability.js";

const CALLBACK_BASE_URL = "https://quire.example.com/callbacks/action-resolution";

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
		const queue = new MergeQueue(statePath, new StubGitHubClient(), CALLBACK_BASE_URL, join(dir, "conflict.ndjson"));
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
		const queue = new MergeQueue(statePath, new StubGitHubClient(), CALLBACK_BASE_URL, join(dir, "conflict.ndjson"));
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
		const queue = new MergeQueue(statePath, new StubGitHubClient(), CALLBACK_BASE_URL, join(dir, "conflict.ndjson"));
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
		const queue = new MergeQueue(statePath, new StubGitHubClient(), CALLBACK_BASE_URL, join(dir, "conflict.ndjson"));
		await queue.load();

		await expect(queue.removeQueued("missing-bundle")).resolves.toBeUndefined();
	});

	it("carries the card through so a later removal can restore it", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-queue-"));
		const statePath = join(dir, "queue.json");
		const queue = new MergeQueue(statePath, new StubGitHubClient(), CALLBACK_BASE_URL, join(dir, "conflict.ndjson"));
		await queue.load();

		await queue.enqueue(makeBundle("bundle-1"), makeCard("bundle-1"));
		const removed = await queue.removeQueued("bundle-1");

		expect(removed?.card).toEqual(makeCard("bundle-1"));
	});

	it("leaves the card undefined when none was provided at enqueue (legacy compatibility)", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-queue-"));
		const statePath = join(dir, "queue.json");
		const queue = new MergeQueue(statePath, new StubGitHubClient(), CALLBACK_BASE_URL, join(dir, "conflict.ndjson"));
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
		const queue = new MergeQueue(join(dir, "queue.json"), github, CALLBACK_BASE_URL, join(dir, "conflict.ndjson"));
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

	it("updates the branch and lands when behind, without ever dispatching the conflict-resolution Action", async () => {
		const { github, queue } = await setup();
		const pr = makePr();
		github.setMergeability(pr.repoOwner, pr.repoName, pr.number, makeMergeability({ state: "behind" }));
		await queue.enqueue(makeBundle("bundle-1", [pr]));

		const landed = await queue.dequeueNext();

		expect(landed?.status).toBe("landed");
		expect(github.updateBranchCalls).toEqual(["org/repo/1"]);
		expect(github.mergedPrs).toEqual(["org/repo/1"]);
		expect(github.dispatchConflictResolutionCalls).toHaveLength(0);
	});

	it("resolves non-overlapping edits via diff3 alone and lands, without dispatching", async () => {
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
		expect(github.dispatchConflictResolutionCalls).toHaveLength(0);
		expect(github.commitResolvedFilesCalls).toHaveLength(1);
		expect(github.commitResolvedFilesCalls[0]?.files).toEqual([
			{ path: "src/auth.ts", content: "line1-ours\nline2\nline3\nline4\nline5-theirs", mode: "100644" },
		]);
	});

	it("dispatches to the conflict-resolution Action and blocks with 'resolving' when diff3 can't auto-merge", async () => {
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

		const resolving = await queue.dequeueNext();

		expect(resolving?.status).toBe("resolving");
		expect(resolving?.resolution).toMatchObject({ prId: pr.id, repoOwner: pr.repoOwner, repoName: pr.repoName });
		expect(resolving?.resolution?.callbackToken).toMatch(/^[0-9a-f]{64}$/);
		expect(github.dispatchConflictResolutionCalls).toHaveLength(1);
		expect(github.mergedPrs).toEqual([]);
		expect(github.commitResolvedFilesCalls).toHaveLength(0);
	});

	it("marks the bundle as conflicted, with no dispatch, when blocked by branch protection", async () => {
		const { github, queue } = await setup();
		const pr = makePr();
		github.setMergeability(pr.repoOwner, pr.repoName, pr.number, makeMergeability({ state: "blocked" }));
		await queue.enqueue(makeBundle("bundle-1", [pr]));

		const blocked = await queue.dequeueNext();

		expect(blocked?.status).toBe("conflict");
		expect(blocked?.conflict?.reason).toContain("branch protection");
		expect(github.dispatchConflictResolutionCalls).toHaveLength(0);
		expect(github.mergedPrs).toEqual([]);
	});

	it("marks the bundle as conflicted, with no dispatch, when checks are unstable", async () => {
		const { github, queue } = await setup();
		const pr = makePr();
		github.setMergeability(pr.repoOwner, pr.repoName, pr.number, makeMergeability({ state: "unstable" }));
		await queue.enqueue(makeBundle("bundle-1", [pr]));

		const blocked = await queue.dequeueNext();

		expect(blocked?.status).toBe("conflict");
		expect(blocked?.conflict?.reason).toContain("status checks");
		expect(github.dispatchConflictResolutionCalls).toHaveLength(0);
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
		const queue = new MergeQueue(join(dir, "queue.json"), github, CALLBACK_BASE_URL, join(dir, "conflict.ndjson"), [0, 0]);
		await queue.load();
		const pr = makePr();
		github.setMergeability(pr.repoOwner, pr.repoName, pr.number, makeMergeability({ state: "unknownPending" }));
		await queue.enqueue(makeBundle("bundle-1", [pr]));

		const blocked = await queue.dequeueNext();

		expect(blocked?.status).toBe("conflict");
		expect(blocked?.conflict?.reason).toContain("did not finish computing");
	});
});

describe("MergeQueue.markResolutionSucceeded / markResolutionFailed", () => {
	let dir: string;

	afterEach(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	async function setupResolving(): Promise<{ github: StubGitHubClient; queue: MergeQueue; pr: PullRequest }> {
		dir = await mkdtemp(join(tmpdir(), "quire-queue-"));
		const github = new StubGitHubClient();
		const queue = new MergeQueue(join(dir, "queue.json"), github, CALLBACK_BASE_URL, join(dir, "conflict.ndjson"));
		await queue.load();
		const pr = makePr();
		const base = "line1\nline2";
		github.setBlobContent("base-sha", base);
		github.setBlobContent("ours-sha", "line1-ours\nline2");
		github.setBlobContent("theirs-sha", "line1-theirs\nline2");
		github.setConflictTrees(pr.repoOwner, pr.repoName, pr.number, makeConflictTrees("src/auth.ts", "base-sha", "ours-sha", "theirs-sha"));
		github.setMergeability(pr.repoOwner, pr.repoName, pr.number, makeMergeability({ state: "dirty" }));
		await queue.enqueue(makeBundle("bundle-1", [pr]));
		await queue.dequeueNext(); // dispatches, leaves the entry "resolving"
		return { github, queue, pr };
	}

	it("returns undefined for a bundle that isn't resolving", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-queue-"));
		const queue = new MergeQueue(join(dir, "queue.json"), new StubGitHubClient(), CALLBACK_BASE_URL, join(dir, "conflict.ndjson"));
		await queue.load();
		await queue.enqueue(makeBundle("bundle-1"));

		await expect(queue.markResolutionSucceeded("bundle-1")).resolves.toBeUndefined();
		await expect(queue.markResolutionFailed("bundle-1", "pr-1", "any reason")).resolves.toBeUndefined();
	});

	it("requeues on success, clearing the resolution, so dequeueNext can land it", async () => {
		const { github, queue, pr } = await setupResolving();

		// The Action pushed a resolving commit directly to the branch — mergeability now clean.
		github.setMergeability(pr.repoOwner, pr.repoName, pr.number, makeMergeability({ state: "clean" }));
		const requeued = await queue.markResolutionSucceeded("bundle-1");

		expect(requeued?.status).toBe("queued");
		expect(requeued?.resolution).toBeUndefined();

		const landed = await queue.dequeueNext();
		expect(landed?.status).toBe("landed");
		expect(github.mergedPrs).toEqual(["org/repo/1"]);
	});

	it("moves to conflict on failure, clearing the resolution and surfacing the reason", async () => {
		const { queue, pr } = await setupResolving();

		const failed = await queue.markResolutionFailed("bundle-1", pr.id, "model declined to resolve confidently");

		expect(failed?.status).toBe("conflict");
		expect(failed?.resolution).toBeUndefined();
		expect(failed?.conflict).toMatchObject({ prId: pr.id, reason: "model declined to resolve confidently" });
	});
});

describe("MergeQueue.retryConflict", () => {
	let dir: string;

	afterEach(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	it("returns undefined when the bundle isn't in a conflict state", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-queue-"));
		const queue = new MergeQueue(join(dir, "queue.json"), new StubGitHubClient(), CALLBACK_BASE_URL, join(dir, "conflict.ndjson"));
		await queue.load();
		await queue.enqueue(makeBundle("bundle-1"));

		await expect(queue.retryConflict("bundle-1")).resolves.toBeUndefined();
	});

	it("clears the conflict and requeues, so a later dequeueNext can land it", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-queue-"));
		const github = new StubGitHubClient();
		const queue = new MergeQueue(join(dir, "queue.json"), github, CALLBACK_BASE_URL, join(dir, "conflict.ndjson"));
		await queue.load();
		const pr = makePr();
		github.setMergeability(pr.repoOwner, pr.repoName, pr.number, makeMergeability({ state: "blocked" }));
		await queue.enqueue(makeBundle("bundle-1", [pr]));
		const blocked = await queue.dequeueNext();
		expect(blocked?.status).toBe("conflict");

		// The human fixes the branch-protection issue on GitHub, then retries.
		github.setMergeability(pr.repoOwner, pr.repoName, pr.number, makeMergeability({ state: "clean" }));
		const retried = await queue.retryConflict("bundle-1");
		expect(retried?.status).toBe("queued");
		expect(retried?.conflict).toBeUndefined();

		const landed = await queue.dequeueNext();
		expect(landed?.status).toBe("landed");
		expect(github.mergedPrs).toEqual(["org/repo/1"]);
	});
});
