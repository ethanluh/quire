import { describe, it, expect, afterEach } from "@jest/globals";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pollPendingResolutions } from "../../src/interface/server/resolutionPoll.js";
import { MergeQueue } from "../../src/engine/queue/mergeQueue.js";
import { StubGitHubClient } from "../../src/engine/github/stubClient.js";
import type { Bundle, PullRequest } from "../../src/engine/types/core.js";
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

function makeBundle(id: string, members: ReadonlyArray<PullRequest>): Bundle {
	return { id, direction: "add passwordless auth", effectSummary: "adds OTP-based login", members };
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

function conflictTrees(): ConflictTrees {
	return {
		mergeBaseSha: "merge-base-sha",
		baseSha: "base-tip-sha",
		headSha: "head-sha",
		mergeBaseTree: new Map([["src/auth.ts", blob("base-sha")]]),
		baseTree: new Map([["src/auth.ts", blob("theirs-sha")]]),
		headTree: new Map([["src/auth.ts", blob("ours-sha")]]),
	};
}

describe("pollPendingResolutions", () => {
	let dir: string;

	afterEach(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	async function setupResolving(dispatchedAtIso: string): Promise<{ queue: MergeQueue; pr: PullRequest }> {
		dir = await mkdtemp(join(tmpdir(), "quire-resolution-poll-"));
		const github = new StubGitHubClient();
		const queue = new MergeQueue(join(dir, "queue.json"), github, CALLBACK_BASE_URL, join(dir, "conflict.ndjson"));
		await queue.load();

		const pr = makePr();
		github.setBlobContent("base-sha", "line1\nline2");
		github.setBlobContent("ours-sha", "line1-ours\nline2");
		github.setBlobContent("theirs-sha", "line1-theirs\nline2");
		github.setConflictTrees(pr.repoOwner, pr.repoName, pr.number, conflictTrees());
		github.setMergeability(pr.repoOwner, pr.repoName, pr.number, makeMergeability());
		await queue.enqueue(makeBundle("bundle-1", [pr]));
		const resolving = await queue.dequeueNext();
		if (resolving?.resolution === undefined) throw new Error("expected dispatch to produce a resolving entry");

		// Back-date dispatchedAt directly in the persisted state so the poll sees it as stale,
		// without needing to fake global timers for the whole test.
		const state = JSON.parse(await readFile(join(dir, "queue.json"), "utf8"));
		state.entries[0].resolution.dispatchedAt = dispatchedAtIso;
		const { writeFile } = await import("node:fs/promises");
		await writeFile(join(dir, "queue.json"), JSON.stringify(state));
		await queue.load();

		return { queue, pr };
	}

	it("leaves a recently-dispatched entry alone", async () => {
		const { queue } = await setupResolving(new Date().toISOString());

		await pollPendingResolutions(queue, 20 * 60_000, join(dir, "conflict.ndjson"));

		const entry = await queue.getEntry("bundle-1");
		expect(entry?.status).toBe("resolving");
	});

	it("moves a stale entry to conflict once past the timeout", async () => {
		const staleIso = new Date(Date.now() - 30 * 60_000).toISOString();
		const { queue, pr } = await setupResolving(staleIso);

		await pollPendingResolutions(queue, 20 * 60_000, join(dir, "conflict.ndjson"));

		const entry = await queue.getEntry("bundle-1");
		expect(entry?.status).toBe("conflict");
		expect(entry?.resolution).toBeUndefined();
		expect(entry?.conflict).toMatchObject({ prId: pr.id });
		expect(entry?.conflict?.reason).toContain("did not report back within 20 minutes");
	});

	it("ignores entries that aren't resolving", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-resolution-poll-"));
		const github = new StubGitHubClient();
		const queue = new MergeQueue(join(dir, "queue.json"), github, CALLBACK_BASE_URL, join(dir, "conflict.ndjson"));
		await queue.load();
		await queue.enqueue(makeBundle("bundle-1", []));

		await expect(pollPendingResolutions(queue, 1, join(dir, "conflict.ndjson"))).resolves.toBeUndefined();
		const entry = await queue.getEntry("bundle-1");
		expect(entry?.status).toBe("queued");
	});
});
