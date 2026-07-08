import { describe, it, expect, afterEach } from "@jest/globals";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MergeQueue } from "../../src/engine/queue/mergeQueue.js";
import type { DeepInvestigationDeps } from "../../src/engine/queue/mergeQueue.js";
import { StubGitHubClient } from "../../src/engine/github/stubClient.js";
import { StubLlmProvider } from "../../src/engine/drift/effectList/stubProvider.js";
import { LlmProviderHolder } from "../../src/engine/drift/effectList/providerHolder.js";
import { StubManagedAgentsClient } from "../../src/engine/queue/stubManagedAgentsClient.js";
import type { ManagedAgentsClient } from "../../src/engine/queue/managedAgentsClient.js";
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
		directionInferred: false,
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
		directionInferred: false,
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
		directionInferred: false,
		repoOwner: "org",
		repoName: "repo",
		blastRadius: 1,
		flags: [],
		drift: { status: "clean" },
		residualDisclosure: "behavioral confirm not run",
		specConformance: { status: "clean" },
		specConformanceDisclosure: "",
		inputsHash: "hash-1",
		memberCount: 0,
		requiresAcceptConfirmation: false,
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

describe("MergeQueue.listEntries — ordering", () => {
	let dir: string;

	afterEach(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	it("puts the most recently landed bundle first, ahead of one landed earlier", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-queue-"));
		const statePath = join(dir, "queue.json");
		const github = new StubGitHubClient();
		const queue = new MergeQueue(statePath, github, llmHolder(), join(dir, "conflict.ndjson"));
		await queue.load();

		// landedAt values are written explicitly, distinct to the millisecond, rather than
		// relying on two real dequeueNext() calls landing in different milliseconds — on a
		// fast machine both calls can complete within the same millisecond, tying landedAt
		// and letting the stable sort fall back to insertion order.
		await writeFile(
			statePath,
			JSON.stringify({
				entries: [
					{
						bundleId: "bundle-1",
						bundle: makeBundle("bundle-1", [makePr({ id: "pr-1" })]),
						enqueuedAt: new Date(0).toISOString(),
						status: "landed",
						landedAt: new Date(1).toISOString(),
						revertedPrIds: [],
						mergedPrIds: ["pr-1"],
					},
					{
						bundleId: "bundle-2",
						bundle: makeBundle("bundle-2", [makePr({ id: "pr-2" })]),
						enqueuedAt: new Date(0).toISOString(),
						status: "landed",
						landedAt: new Date(2).toISOString(),
						revertedPrIds: [],
						mergedPrIds: ["pr-2"],
					},
				],
			}),
			"utf8",
		);
		await queue.load();

		const entries = await queue.listEntries();
		expect(entries.map((e) => e.bundleId)).toEqual(["bundle-2", "bundle-1"]);
	});

	it("keeps a still-queued entry ahead of the landed group even though it landed after", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-queue-"));
		const statePath = join(dir, "queue.json");
		const queue = new MergeQueue(statePath, new StubGitHubClient(), llmHolder(), join(dir, "conflict.ndjson"));
		await queue.load();

		await queue.enqueue(makeBundle("bundle-1", [makePr({ id: "pr-1" })]));
		await queue.enqueue(makeBundle("bundle-2", [makePr({ id: "pr-2" })]));
		await queue.dequeueNext(); // lands bundle-1, bundle-2 stays queued

		const entries = await queue.listEntries();
		expect(entries.map((e) => e.bundleId)).toEqual(["bundle-2", "bundle-1"]);
		expect(entries[0]?.status).toBe("queued");
	});

	it("sorts still-queued entries most-recently-enqueued first, ahead of the landed group", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-queue-"));
		const statePath = join(dir, "queue.json");
		const queue = new MergeQueue(statePath, new StubGitHubClient(), llmHolder(), join(dir, "conflict.ndjson"));
		await queue.load();

		await queue.enqueue(makeBundle("bundle-1", [makePr({ id: "pr-1" })]));
		await new Promise((resolve) => setTimeout(resolve, 2)); // force a distinct enqueuedAt millisecond
		await queue.enqueue(makeBundle("bundle-2", [makePr({ id: "pr-2" })]));

		const entries = await queue.listEntries();
		expect(entries.map((e) => e.bundleId)).toEqual(["bundle-2", "bundle-1"]);
	});
});

describe("MergeQueue.dequeueNext — mergeability handling", () => {
	let dir: string;

	afterEach(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	async function setup(shouldFlagForFleet: () => boolean = () => false): Promise<{ github: StubGitHubClient; queue: MergeQueue }> {
		dir = await mkdtemp(join(tmpdir(), "quire-queue-"));
		const github = new StubGitHubClient();
		const queue = new MergeQueue(
			join(dir, "queue.json"),
			github,
			llmHolder(),
			join(dir, "conflict.ndjson"),
			undefined,
			shouldFlagForFleet,
		);
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
		expect(blocked?.conflict?.kind).toBe("mergeConflict");
		expect(github.mergedPrs).toEqual([]);
		expect(github.commitResolvedFilesCalls).toHaveLength(0);
	});

	it("posts a PR comment flagging the conflict for the fleet when shouldFlagForFleet is on and resolution fails", async () => {
		const { github, queue } = await setup(() => true);
		const pr = makePr();
		const base = "line1\nline2";
		const ours = "line1-ours\nline2";
		const theirs = "line1-theirs\nline2";
		github.setBlobContent("base-sha", base);
		github.setBlobContent("ours-sha", ours);
		github.setBlobContent("theirs-sha", theirs);
		github.setConflictTrees(pr.repoOwner, pr.repoName, pr.number, makeConflictTrees("src/auth.ts", "base-sha", "ours-sha", "theirs-sha"));
		github.setMergeability(pr.repoOwner, pr.repoName, pr.number, makeMergeability({ state: "dirty" }));
		await queue.enqueue(makeBundle("bundle-1", [pr]));

		const blocked = await queue.dequeueNext();

		expect(blocked?.status).toBe("conflict");
		expect(github.postedComments).toHaveLength(1);
		expect(github.postedComments[0]).toMatchObject({ owner: "org", repo: "repo", prNumber: 1 });
		expect(github.postedComments[0]?.body).toContain("could not confidently resolve 1 conflicting hunk");
	});

	it("does not post a PR comment when shouldFlagForFleet is off", async () => {
		const { github, queue } = await setup(() => false);
		const pr = makePr();
		const base = "line1\nline2";
		const ours = "line1-ours\nline2";
		const theirs = "line1-theirs\nline2";
		github.setBlobContent("base-sha", base);
		github.setBlobContent("ours-sha", ours);
		github.setBlobContent("theirs-sha", theirs);
		github.setConflictTrees(pr.repoOwner, pr.repoName, pr.number, makeConflictTrees("src/auth.ts", "base-sha", "ours-sha", "theirs-sha"));
		github.setMergeability(pr.repoOwner, pr.repoName, pr.number, makeMergeability({ state: "dirty" }));
		await queue.enqueue(makeBundle("bundle-1", [pr]));

		const blocked = await queue.dequeueNext();

		expect(blocked?.status).toBe("conflict");
		expect(github.postedComments).toHaveLength(0);
	});

	it("marks the bundle as conflicted when blocked by branch protection", async () => {
		const { github, queue } = await setup();
		const pr = makePr();
		github.setMergeability(pr.repoOwner, pr.repoName, pr.number, makeMergeability({ state: "blocked" }));
		await queue.enqueue(makeBundle("bundle-1", [pr]));

		const blocked = await queue.dequeueNext();

		expect(blocked?.status).toBe("conflict");
		expect(blocked?.conflict?.reason).toContain("branch protection");
		expect(blocked?.conflict?.kind).toBe("blocked");
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
		expect(blocked?.conflict?.kind).toBe("unstable");
	});

	it("bails to conflict without attempting a write when the PR head lives in a fork", async () => {
		const { github, queue } = await setup();
		const pr = makePr();
		github.setMergeability(pr.repoOwner, pr.repoName, pr.number, makeMergeability({ state: "behind", isFork: true }));
		await queue.enqueue(makeBundle("bundle-1", [pr]));

		const blocked = await queue.dequeueNext();

		expect(blocked?.status).toBe("conflict");
		expect(blocked?.conflict?.reason).toContain("fork");
		expect(blocked?.conflict?.kind).toBe("unresolvable");
		expect(github.updateBranchCalls).toEqual([]);
	});

	it("bails to conflict when a branch update leaves the PR in an unexpected, non-dirty state", async () => {
		const { github, queue } = await setup();
		const pr = makePr();
		github.setMergeability(pr.repoOwner, pr.repoName, pr.number, makeMergeability({ state: "behind" }));
		// Simulates updateBranch() succeeding but mergeable_state not settling to clean or
		// dirty afterward — leave the stub's post-update auto-clean behavior off so the poll
		// re-reads the same "behind" fixture, which is neither a mergeable state nor "dirty".
		github.autoMarkMergeableAfterSuccess = false;
		await queue.enqueue(makeBundle("bundle-1", [pr]));

		const blocked = await queue.dequeueNext();

		expect(blocked?.status).toBe("conflict");
		expect(blocked?.conflict?.reason).toContain("unexpected state: behind");
		expect(blocked?.conflict?.kind).toBe("unresolvable");
	});

	it("bails to conflict when the base branch has moved again after a successful resolution", async () => {
		const { github, queue } = await setup();
		const pr = makePr();
		const base = "line1\nline2\nline3\nline4\nline5";
		const ours = "line1-ours\nline2\nline3\nline4\nline5";
		const theirs = "line1\nline2\nline3\nline4\nline5-theirs";
		github.setBlobContent("base-sha", base);
		github.setBlobContent("ours-sha", ours);
		github.setBlobContent("theirs-sha", theirs);
		github.setConflictTrees(pr.repoOwner, pr.repoName, pr.number, makeConflictTrees("src/auth.ts", "base-sha", "ours-sha", "theirs-sha"));
		github.setMergeability(pr.repoOwner, pr.repoName, pr.number, makeMergeability({ state: "dirty" }));
		// commitResolvedFiles() succeeds (diff3 resolves cleanly), but leave the stub's
		// post-success auto-clean off so the re-poll still reports "dirty" — simulating the
		// base branch moving again during resolution.
		github.autoMarkMergeableAfterSuccess = false;
		await queue.enqueue(makeBundle("bundle-1", [pr]));

		const blocked = await queue.dequeueNext();

		expect(blocked?.status).toBe("conflict");
		expect(blocked?.conflict?.reason).toContain("base branch likely moved again");
		expect(blocked?.conflict?.kind).toBe("unresolvable");
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
		expect(blocked?.conflict?.kind).toBe("timedOut");
	});

	it("treats a mergePullRequest exception as success once GitHub confirms the merge actually went through", async () => {
		// Regression: a response timeout or similar transient failure right after GitHub
		// commits the merge server-side used to propagate straight out of dequeueNextLocked,
		// leaving the entry understating reality ("landing") until some unrelated pass
		// (a webhook, or the next dequeueNext() resuming) happened to notice via alreadyMerged.
		const { github, queue } = await setup();
		const pr = makePr();
		github.mergePullRequestError = new Error("response timeout");
		github.mergePullRequestErrorButActuallyMerged = true;
		await queue.enqueue(makeBundle("bundle-1", [pr]));

		const landed = await queue.dequeueNext();

		expect(landed?.status).toBe("landed");
		expect(landed?.mergedPrIds).toEqual([pr.id]);
		expect(github.mergedPrs).toEqual([]); // never recorded as a plain (non-throwing) merge call
	});

	it("rethrows a mergePullRequest exception when GitHub did not actually merge", async () => {
		const { github, queue } = await setup();
		const pr = makePr();
		github.mergePullRequestError = new Error("network blip");
		await queue.enqueue(makeBundle("bundle-1", [pr]));

		await expect(queue.dequeueNext()).rejects.toThrow("network blip");

		// Left in "landing" (not "conflict") so the next dequeueNext() resumes cleanly and
		// re-attempts this exact member, same as a mid-merge crash.
		const entry = await queue.getEntry("bundle-1");
		expect(entry?.status).toBe("landing");
		expect(entry?.mergedPrIds).toEqual([]);
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

describe("MergeQueue.reattemptForPr", () => {
	let dir: string;

	afterEach(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	it("clears a conflict entry matching the given PR id and requeues it", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-queue-"));
		const github = new StubGitHubClient();
		const queue = new MergeQueue(join(dir, "queue.json"), github, llmHolder(), join(dir, "conflict.ndjson"));
		await queue.load();
		const pr = makePr();
		github.setMergeability(pr.repoOwner, pr.repoName, pr.number, makeMergeability({ state: "blocked" }));
		await queue.enqueue(makeBundle("bundle-1", [pr]));
		const blocked = await queue.dequeueNext();
		expect(blocked?.status).toBe("conflict");

		github.setMergeability(pr.repoOwner, pr.repoName, pr.number, makeMergeability({ state: "clean" }));
		const retried = await queue.reattemptForPr(pr.id);

		expect(retried?.bundleId).toBe("bundle-1");
		expect(retried?.status).toBe("queued");
		expect(retried?.conflict).toBeUndefined();

		const landed = await queue.dequeueNext();
		expect(landed?.status).toBe("landed");
		expect(github.mergedPrs).toEqual(["org/repo/1"]);
	});

	it("returns undefined when no entry is in conflict for that PR", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-queue-"));
		const queue = new MergeQueue(join(dir, "queue.json"), new StubGitHubClient(), llmHolder(), join(dir, "conflict.ndjson"));
		await queue.load();
		await queue.enqueue(makeBundle("bundle-1", [makePr()]));

		await expect(queue.reattemptForPr("pr-1")).resolves.toBeUndefined();
	});

	it("does not match an aborted entry, even with a stale matching conflict.prId", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-queue-"));
		const github = new StubGitHubClient();
		const queue = new MergeQueue(join(dir, "queue.json"), github, llmHolder(), join(dir, "conflict.ndjson"));
		await queue.load();
		const pr = makePr();
		github.setMergeability(pr.repoOwner, pr.repoName, pr.number, makeMergeability({ state: "blocked" }));
		await queue.enqueue(makeBundle("bundle-1", [pr]));
		await queue.dequeueNext();
		await queue.abort("bundle-1");

		await expect(queue.reattemptForPr(pr.id)).resolves.toBeUndefined();
		expect((await queue.getEntry("bundle-1"))?.status).toBe("aborted");
	});
});

describe("MergeQueue.recordExternalMerge", () => {
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

	it("lands a single-member bundle whose only PR was merged externally, without calling GitHub's merge API", async () => {
		const { github, queue } = await setup();
		const pr = makePr();
		await queue.enqueue(makeBundle("bundle-1", [pr]));

		const updated = await queue.recordExternalMerge(pr.id);

		expect(updated?.status).toBe("landed");
		expect(updated?.mergedPrIds).toEqual([pr.id]);
		expect(updated?.landedAt).toEqual(expect.any(String));
		expect(github.mergedPrs).toEqual([]);
	});

	it("keeps a multi-member bundle queued when only one member was merged externally", async () => {
		const { queue } = await setup();
		const pr1 = makePr({ id: "pr-1", number: 1 });
		const pr2 = makePr({ id: "pr-2", number: 2 });
		await queue.enqueue(makeBundle("bundle-1", [pr1, pr2]));

		const updated = await queue.recordExternalMerge(pr1.id);

		expect(updated?.status).toBe("queued");
		expect(updated?.mergedPrIds).toEqual([pr1.id]);
	});

	it("clears a conflict recorded against the externally-merged PR and requeues the bundle when a member is still pending", async () => {
		const { github, queue } = await setup();
		const pr1 = makePr({ id: "pr-1", number: 1 });
		const pr2 = makePr({ id: "pr-2", number: 2 });
		const pr3 = makePr({ id: "pr-3", number: 3 });
		github.setMergeability(pr2.repoOwner, pr2.repoName, pr2.number, makeMergeability({ state: "blocked" }));
		await queue.enqueue(makeBundle("bundle-1", [pr1, pr2, pr3]));
		const blocked = await queue.dequeueNext(); // merges pr1, blocks on pr2; pr3 never attempted
		expect(blocked?.status).toBe("conflict");
		expect(blocked?.conflict?.prId).toBe(pr2.id);

		// The human resolves the branch-protection block by merging pr2 themselves.
		const updated = await queue.recordExternalMerge(pr2.id);

		expect(updated?.status).toBe("queued");
		expect(updated?.conflict).toBeUndefined();
		expect(updated?.mergedPrIds.slice().sort()).toEqual([pr1.id, pr2.id].sort());
	});

	it("does not clear a conflict when a different, unrelated pending member is merged externally", async () => {
		const { github, queue } = await setup();
		const pr1 = makePr({ id: "pr-1", number: 1 });
		const pr2 = makePr({ id: "pr-2", number: 2 });
		const pr3 = makePr({ id: "pr-3", number: 3 });
		github.setMergeability(pr2.repoOwner, pr2.repoName, pr2.number, makeMergeability({ state: "blocked" }));
		await queue.enqueue(makeBundle("bundle-1", [pr1, pr2, pr3]));
		const blocked = await queue.dequeueNext(); // merges pr1, blocks on pr2; pr3 never attempted
		expect(blocked?.status).toBe("conflict");

		// pr3 merges for unrelated reasons — pr2's conflict was never actually resolved.
		const updated = await queue.recordExternalMerge(pr3.id);

		expect(updated?.status).toBe("conflict");
		expect(updated?.conflict?.prId).toBe(pr2.id);
		expect(updated?.mergedPrIds.slice().sort()).toEqual([pr1.id, pr3.id].sort());
	});

	it("does not carry a stale abortedAt into a bundle that lands after its last pending member merges externally", async () => {
		const { github, queue } = await setup();
		const pr1 = makePr({ id: "pr-1", number: 1 });
		const pr2 = makePr({ id: "pr-2", number: 2 });
		github.setMergeability(pr2.repoOwner, pr2.repoName, pr2.number, makeMergeability({ state: "blocked" }));
		await queue.enqueue(makeBundle("bundle-1", [pr1, pr2]));
		await queue.dequeueNext(); // merges pr1, blocks (conflict) on pr2
		const aborted = await queue.abort("bundle-1");
		expect(aborted?.abortedAt).toEqual(expect.any(String));

		const updated = await queue.recordExternalMerge(pr2.id);

		expect(updated?.status).toBe("landed");
		expect(updated?.abortedAt).toBeUndefined();
	});

	it("leaves a bundle mid-'landing' untouched in status, so a resumed dequeueNext skips the externally-merged member", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-queue-"));
		const statePath = join(dir, "queue.json");
		const github = new StubGitHubClient();
		const pr1 = makePr({ id: "pr-1", number: 1 });
		const pr2 = makePr({ id: "pr-2", number: 2 });
		const bundle = makeBundle("bundle-1", [pr1, pr2]);
		// Simulates a crash mid-dequeueNext(): status flipped to "landing" but no member merged yet.
		await writeFile(
			statePath,
			JSON.stringify({
				entries: [
					{
						bundleId: "bundle-1",
						bundle,
						enqueuedAt: new Date(0).toISOString(),
						status: "landing",
						revertedPrIds: [],
						mergedPrIds: [],
					},
				],
			}),
			"utf8",
		);
		const queue = new MergeQueue(statePath, github, llmHolder(), join(dir, "conflict.ndjson"));
		await queue.load();

		// pr2 gets merged by a human directly on GitHub while Quire's own landing attempt is
		// presumed crashed or stalled.
		const updated = await queue.recordExternalMerge(pr2.id);
		expect(updated?.status).toBe("landing");
		expect(updated?.mergedPrIds).toEqual([pr2.id]);

		const landed = await queue.dequeueNext();
		expect(landed?.status).toBe("landed");
		expect(landed?.mergedPrIds.slice().sort()).toEqual([pr1.id, pr2.id].sort());
		expect(github.mergedPrs).toEqual(["org/repo/1"]); // only pr1 actually merged through Quire
	});

	it("records an externally-merged member on an aborted bundle without reviving it, when a member is still pending", async () => {
		const { github, queue } = await setup();
		const pr1 = makePr({ id: "pr-1", number: 1 });
		const pr2 = makePr({ id: "pr-2", number: 2 });
		const pr3 = makePr({ id: "pr-3", number: 3 });
		github.setMergeability(pr2.repoOwner, pr2.repoName, pr2.number, makeMergeability({ state: "blocked" }));
		await queue.enqueue(makeBundle("bundle-1", [pr1, pr2, pr3]));
		await queue.dequeueNext(); // merges pr1, blocks (conflict) on pr2; pr3 never attempted
		await queue.abort("bundle-1");

		const updated = await queue.recordExternalMerge(pr2.id);

		expect(updated?.status).toBe("aborted");
		expect(updated?.mergedPrIds.slice().sort()).toEqual([pr1.id, pr2.id].sort());
	});

	it("is idempotent — a PR already recorded as merged matches no entry", async () => {
		const { queue } = await setup();
		const pr = makePr();
		await queue.enqueue(makeBundle("bundle-1", [pr]));
		await queue.recordExternalMerge(pr.id); // lands it

		await expect(queue.recordExternalMerge(pr.id)).resolves.toBeUndefined();
	});

	it("returns undefined when no queue entry contains the PR", async () => {
		const { queue } = await setup();

		await expect(queue.recordExternalMerge("pr-missing")).resolves.toBeUndefined();
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

describe("MergeQueue deep conflict investigation", () => {
	let dir: string;

	afterEach(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	const agentRef = { agentId: "agent-1", agentVersion: 1, environmentId: "env-1" };

	function deepInvestigationDeps(client: ManagedAgentsClient, shouldEnable = true): DeepInvestigationDeps {
		return {
			shouldEnable: () => shouldEnable,
			getClient: () => client,
			ensureAgent: async () => agentRef,
			mintRepoToken: async () => "repo-token",
		};
	}

	async function setupWithLowConfidenceConflict(deps: DeepInvestigationDeps | undefined): Promise<{ github: StubGitHubClient; queue: MergeQueue; pr: PullRequest }> {
		dir = await mkdtemp(join(tmpdir(), "quire-queue-"));
		const github = new StubGitHubClient();
		const queue = new MergeQueue(join(dir, "queue.json"), github, llmHolder(), join(dir, "conflict.ndjson"), undefined, undefined, deps);
		await queue.load();
		const pr = makePr();
		const base = "line1\nline2";
		const ours = "line1-ours\nline2";
		const theirs = "line1-theirs\nline2";
		github.setBlobContent("base-sha", base);
		github.setBlobContent("ours-sha", ours);
		github.setBlobContent("theirs-sha", theirs);
		github.setConflictTrees(pr.repoOwner, pr.repoName, pr.number, makeConflictTrees("src/auth.ts", "base-sha", "ours-sha", "theirs-sha"));
		github.setMergeability(pr.repoOwner, pr.repoName, pr.number, makeMergeability({ state: "dirty" }));
		await queue.enqueue(makeBundle("bundle-1", [pr]));
		return { github, queue, pr };
	}

	it("starts an investigation session and marks the bundle 'investigating' when enabled", async () => {
		const client = new StubManagedAgentsClient();
		const { queue } = await setupWithLowConfidenceConflict(deepInvestigationDeps(client));

		const blocked = await queue.dequeueNext();

		expect(blocked?.status).toBe("investigating");
		expect(blocked?.investigations).toHaveLength(1);
		expect(blocked?.investigations?.[0]).toMatchObject({ path: "src/auth.ts", status: "running" });
		expect(client.createdSessions).toHaveLength(1);
		expect(client.sentMessages).toHaveLength(1);
	});

	it("falls back to plain 'conflict' when the setting is off", async () => {
		const client = new StubManagedAgentsClient();
		const { queue } = await setupWithLowConfidenceConflict(deepInvestigationDeps(client, false));

		const blocked = await queue.dequeueNext();

		expect(blocked?.status).toBe("conflict");
		expect(blocked?.investigations).toBeUndefined();
		expect(client.createdSessions).toHaveLength(0);
	});

	it("falls back to plain 'conflict' when no deep-investigation deps are configured", async () => {
		const { queue } = await setupWithLowConfidenceConflict(undefined);

		const blocked = await queue.dequeueNext();

		expect(blocked?.status).toBe("conflict");
	});

	it("pollInvestigations flips the bundle back to 'conflict' with the decision packet once the session finishes", async () => {
		const client = new StubManagedAgentsClient();
		const { queue } = await setupWithLowConfidenceConflict(deepInvestigationDeps(client));

		const blocked = await queue.dequeueNext();
		const sessionId = blocked?.investigations?.[0]?.sessionId ?? "";
		client.setSessionStatus(sessionId, "idle");
		const packet = {
			rationale: "merged both call sites",
			evidence: ["src/auth.ts:1"],
			testsRun: [],
			testResult: "unknown" as const,
			confidence: "high" as const,
			proposedResolution: "line1-merged\nline2",
		};
		client.setFinalAgentMessage(sessionId, JSON.stringify(packet));

		await queue.pollInvestigations();

		const entry = await queue.getEntry("bundle-1");
		expect(entry?.status).toBe("conflict");
		expect(entry?.investigations?.[0]).toMatchObject({ status: "awaitingReview", decisionPacket: packet });
	});

	it("acceptInvestigation applies the proposed resolution and requeues the bundle", async () => {
		const client = new StubManagedAgentsClient();
		const { github, queue } = await setupWithLowConfidenceConflict(deepInvestigationDeps(client));

		const blocked = await queue.dequeueNext();
		const sessionId = blocked?.investigations?.[0]?.sessionId ?? "";
		client.setSessionStatus(sessionId, "idle");
		client.setFinalAgentMessage(
			sessionId,
			JSON.stringify({
				rationale: "r",
				evidence: [],
				testsRun: [],
				testResult: "passed",
				confidence: "high",
				proposedResolution: "line1-merged\nline2",
			}),
		);
		await queue.pollInvestigations();

		const accepted = await queue.acceptInvestigation("bundle-1", "src/auth.ts");

		expect(accepted?.status).toBe("queued");
		expect(accepted?.investigations?.[0]?.status).toBe("accepted");
		expect(github.commitResolvedFilesCalls).toHaveLength(1);
		expect(github.commitResolvedFilesCalls[0]?.files).toEqual([{ path: "src/auth.ts", content: "line1-merged\nline2", mode: "100644" }]);
	});

	it("rejectInvestigation clears the packet without touching mergeability", async () => {
		const client = new StubManagedAgentsClient();
		const { github, queue } = await setupWithLowConfidenceConflict(deepInvestigationDeps(client));

		const blocked = await queue.dequeueNext();
		const sessionId = blocked?.investigations?.[0]?.sessionId ?? "";
		client.setSessionStatus(sessionId, "idle");
		client.setFinalAgentMessage(
			sessionId,
			JSON.stringify({ rationale: "r", evidence: [], testsRun: [], testResult: "unknown", confidence: "low", proposedResolution: "x" }),
		);
		await queue.pollInvestigations();

		const rejected = await queue.rejectInvestigation("bundle-1", "src/auth.ts");

		expect(rejected?.status).toBe("conflict");
		expect(rejected?.investigations?.[0]?.status).toBe("rejected");
		expect(github.commitResolvedFilesCalls).toHaveLength(0);
	});
});

describe("MergeQueue.recordExternalMerge — deep investigation interaction", () => {
	let dir: string;

	afterEach(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	const agentRef = { agentId: "agent-1", agentVersion: 1, environmentId: "env-1" };

	function deepInvestigationDeps(client: ManagedAgentsClient): DeepInvestigationDeps {
		return {
			shouldEnable: () => true,
			getClient: () => client,
			ensureAgent: async () => agentRef,
			mintRepoToken: async () => "repo-token",
		};
	}

	async function setup(): Promise<{ queue: MergeQueue; pr1: PullRequest; pr2: PullRequest }> {
		dir = await mkdtemp(join(tmpdir(), "quire-queue-"));
		const github = new StubGitHubClient();
		const client = new StubManagedAgentsClient();
		const queue = new MergeQueue(
			join(dir, "queue.json"),
			github,
			llmHolder(),
			join(dir, "conflict.ndjson"),
			undefined,
			undefined,
			deepInvestigationDeps(client),
		);
		await queue.load();
		const pr1 = makePr({ id: "pr-1", number: 1 });
		const pr2 = makePr({ id: "pr-2", number: 2 });
		const base = "line1\nline2";
		const ours = "line1-ours\nline2";
		const theirs = "line1-theirs\nline2";
		github.setBlobContent("base-sha", base);
		github.setBlobContent("ours-sha", ours);
		github.setBlobContent("theirs-sha", theirs);
		github.setConflictTrees(pr1.repoOwner, pr1.repoName, pr1.number, makeConflictTrees("src/auth.ts", "base-sha", "ours-sha", "theirs-sha"));
		github.setMergeability(pr1.repoOwner, pr1.repoName, pr1.number, makeMergeability({ state: "dirty" }));
		await queue.enqueue(makeBundle("bundle-1", [pr1, pr2]));
		return { queue, pr1, pr2 };
	}

	it("marks the in-flight investigation rejected and requeues when the investigated PR itself merges externally", async () => {
		const { queue, pr1 } = await setup();
		const blocked = await queue.dequeueNext(); // pr1 low-confidence conflict -> investigating; pr2 never attempted
		expect(blocked?.status).toBe("investigating");

		const updated = await queue.recordExternalMerge(pr1.id);

		expect(updated?.status).toBe("queued");
		expect(updated?.investigations?.[0]).toMatchObject({ prId: pr1.id, status: "rejected" });
		expect(updated?.mergedPrIds).toEqual([pr1.id]);
	});

	it("leaves an in-flight investigation running when an unrelated pending member merges externally", async () => {
		const { queue, pr1, pr2 } = await setup();
		const blocked = await queue.dequeueNext(); // pr1 low-confidence conflict -> investigating; pr2 never attempted
		expect(blocked?.status).toBe("investigating");

		const updated = await queue.recordExternalMerge(pr2.id);

		expect(updated?.status).toBe("investigating");
		expect(updated?.investigations?.[0]).toMatchObject({ prId: pr1.id, status: "running" });
		expect(updated?.mergedPrIds).toEqual([pr2.id]);
	});
});
