import { describe, it, expect, afterEach } from "@jest/globals";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import type { Server } from "node:http";
import { actionCallbackRouter } from "../../src/interface/server/routes/actionCallback.js";
import { MergeQueue } from "../../src/engine/queue/mergeQueue.js";
import { StubGitHubClient } from "../../src/engine/github/stubClient.js";
import type { Bundle, PullRequest } from "../../src/engine/types/core.js";
import type { ConflictTrees, MergeabilityResult, TreeEntry } from "../../src/engine/types/mergeability.js";

const CALLBACK_BASE_URL = "https://quire.example.com/callbacks/action-resolution";

// The route's auto-continue after a callback is fire-and-forget, so how long it takes to
// land depends on scheduler/disk load under a parallel test run — poll instead of a fixed
// sleep to avoid flaking when the machine is busy.
async function waitFor<T>(check: () => Promise<T | undefined>, timeoutMs = 2000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const result = await check();
		if (result !== undefined) return result;
		if (Date.now() > deadline) throw new Error("waitFor timed out");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
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

describe("actionCallbackRouter", () => {
	let dir: string;
	let server: Server;

	afterEach(async () => {
		if (server) await new Promise((resolve) => server.close(resolve));
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	// Dispatches a real conflict through the queue so the entry ends up "resolving" with a
	// genuine callback token — mirrors how the token actually gets minted in production
	// rather than reaching into queue internals.
	async function setup(): Promise<{ github: StubGitHubClient; queue: MergeQueue; pr: PullRequest; callbackToken: string }> {
		dir = await mkdtemp(join(tmpdir(), "quire-callback-"));
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
		const callbackToken = resolving?.resolution?.callbackToken;
		if (callbackToken === undefined) throw new Error("expected dispatch to produce a resolving entry");

		const app = express();
		app.use(express.json());
		app.use(actionCallbackRouter(queue, join(dir, "conflict.ndjson")));
		server = app.listen(0);

		return { github, queue, pr, callbackToken };
	}

	async function post(path: string, token: string | undefined, body: unknown): Promise<{ status: number; body: unknown }> {
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("no address");
		const res = await fetch(`http://127.0.0.1:${address.port}${path}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(token !== undefined ? { "x-quire-callback-token": token } : {}),
			},
			body: JSON.stringify(body),
		});
		return { status: res.status, body: await res.json() };
	}

	it("requeues the bundle on a valid resolved callback and triggers a merge attempt", async () => {
		const { github, queue, pr, callbackToken } = await setup();
		github.setMergeability(pr.repoOwner, pr.repoName, pr.number, makeMergeability({ state: "clean" }));

		const { status, body } = await post("/bundle-1/resolution", callbackToken, { outcome: "resolved" });

		expect(status).toBe(200);
		expect(body).toEqual({ acknowledged: true });

		// Auto-continue is fire-and-forget — poll the persisted state (not just the in-memory
		// queue) rather than a fixed sleep, so the test only proceeds once dequeueNext()'s own
		// write has actually landed on disk; otherwise afterEach's rm() can race a still-in-
		// flight write and flake with ENOTEMPTY.
		await waitFor(async () => {
			const persisted = JSON.parse(await readFile(join(dir, "queue.json"), "utf8")) as { entries: Array<{ status: string }> };
			return persisted.entries[0]?.status === "landed" ? true : undefined;
		});
		const entry = await queue.getEntry("bundle-1");
		expect(entry?.status).toBe("landed");
		expect(github.mergedPrs).toEqual(["org/repo/1"]);
	});

	it("moves the bundle to conflict on an unresolved callback, surfacing the reason", async () => {
		const { queue, pr, callbackToken } = await setup();

		const { status } = await post("/bundle-1/resolution", callbackToken, {
			outcome: "unresolved",
			reason: "could not confidently resolve",
		});

		expect(status).toBe(200);
		const entry = await queue.getEntry("bundle-1");
		expect(entry?.status).toBe("conflict");
		expect(entry?.conflict).toMatchObject({ prId: pr.id, reason: "could not confidently resolve" });
		expect(entry?.resolution).toBeUndefined();
	});

	it("rejects a missing or wrong callback token with 401 and leaves the entry resolving", async () => {
		const { queue, callbackToken } = await setup();

		const wrongToken = await post("/bundle-1/resolution", `${callbackToken}x`, { outcome: "resolved" });
		expect(wrongToken.status).toBe(401);

		const missingToken = await post("/bundle-1/resolution", undefined, { outcome: "resolved" });
		expect(missingToken.status).toBe(401);

		const entry = await queue.getEntry("bundle-1");
		expect(entry?.status).toBe("resolving");
	});

	it("404s for a bundle that isn't currently resolving", async () => {
		const { callbackToken } = await setup();

		const { status } = await post("/no-such-bundle/resolution", callbackToken, { outcome: "resolved" });

		expect(status).toBe(404);
	});

	it("400s on a malformed body", async () => {
		const { callbackToken } = await setup();

		const { status } = await post("/bundle-1/resolution", callbackToken, { outcome: "maybe" });

		expect(status).toBe(400);
	});

	it("logs the outcome to the conflict-resolution log", async () => {
		const { callbackToken } = await setup();

		await post("/bundle-1/resolution", callbackToken, { outcome: "unresolved", reason: "nope" });

		const logContent = await readFile(join(dir, "conflict.ndjson"), "utf8");
		expect(logContent).toContain('"outcome":"unresolved"');
		expect(logContent).toContain('"reason":"nope"');
	});
});
