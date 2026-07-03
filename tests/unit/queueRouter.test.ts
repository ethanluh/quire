import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import express from "express";
import type { Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { queueRouter } from "../../src/interface/server/routes/queue.js";
import { MergeQueue } from "../../src/engine/queue/mergeQueue.js";
import { StubGitHubClient } from "../../src/engine/github/stubClient.js";
import { StubLlmProvider } from "../../src/engine/drift/effectList/stubProvider.js";
import { LlmProviderHolder } from "../../src/engine/drift/effectList/providerHolder.js";
import { DecidedPrStore } from "../../src/engine/queue/decidedPrStore.js";
import { createServerState } from "../../src/interface/server/state.js";
import type { Bundle, ReviewCard } from "../../src/engine/types/core.js";

function makeBundle(id: string): Bundle {
	return {
		id,
		direction: "add passwordless auth",
		effectSummary: "adds OTP-based login",
		members: [
			{
				id: `${id}-pr-1`,
				repoOwner: "org",
				repoName: "repo",
				number: 1,
				headSha: "sha-1",
				declaredDirection: "add passwordless auth",
				diff: { raw: "", hunks: [] },
				filesTouched: [],
				symbolsTouched: [],
				testNamesChanged: [],
				ciStatus: "success",
			},
		],
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
		memberCount: 1,
	};
}

describe("queueRouter — DELETE /:bundleId", () => {
	let server: Server;
	let baseUrl: string;
	let dataDir: string;
	let queue: MergeQueue;
	let state: ReturnType<typeof createServerState>;
	let decidedStore: DecidedPrStore;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "quire-test-"));
		queue = new MergeQueue(join(dataDir, "queue.json"), new StubGitHubClient(), new LlmProviderHolder(new StubLlmProvider()), join(dataDir, "conflict.ndjson"));
		await queue.load();
		state = createServerState();
		decidedStore = new DecidedPrStore(join(dataDir, "decided-prs.json"));
		await decidedStore.load();

		const app = express();
		app.use(express.json());
		app.use("/queue", queueRouter(queue, state, decidedStore));

		await new Promise<void>((resolve) => {
			server = app.listen(0, resolve);
		});
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("expected AddressInfo");
		baseUrl = `http://127.0.0.1:${address.port}`;
	});

	afterEach(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(dataDir, { recursive: true, force: true });
	});

	it("removes a queued bundle with no card and it no longer appears in the listing", async () => {
		await queue.enqueue(makeBundle("bundle-1"));

		const res = await fetch(`${baseUrl}/queue/bundle-1`, { method: "DELETE" });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: "removed", bundleId: "bundle-1" });

		const listRes = await fetch(`${baseUrl}/queue`);
		expect(await listRes.json()).toEqual([]);
		expect(state.cards.has("bundle-1")).toBe(false);
	});

	it("restores a removed bundle's card and bundle to the review queue", async () => {
		await queue.enqueue(makeBundle("bundle-1"), makeCard("bundle-1"));

		const res = await fetch(`${baseUrl}/queue/bundle-1`, { method: "DELETE" });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: "restored", bundleId: "bundle-1" });

		expect(state.cards.get("bundle-1")).toEqual(makeCard("bundle-1"));
		expect(state.bundles.get("bundle-1")).toEqual(makeBundle("bundle-1"));
	});

	it("clears decided status for a restored bundle's members", async () => {
		await queue.enqueue(makeBundle("bundle-1"), makeCard("bundle-1"));
		await decidedStore.markDecided(["bundle-1-pr-1"], "accept");

		await fetch(`${baseUrl}/queue/bundle-1`, { method: "DELETE" });

		expect(decidedStore.isDecided("bundle-1-pr-1")).toBe(false);
	});

	it("leaves a landed bundle in the queue", async () => {
		await queue.enqueue(makeBundle("bundle-1"));
		await queue.dequeueNext();

		const res = await fetch(`${baseUrl}/queue/bundle-1`, { method: "DELETE" });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: "removed" });

		const listRes = await fetch(`${baseUrl}/queue`);
		const entries = (await listRes.json()) as ReadonlyArray<{ bundleId: string }>;
		expect(entries.map((e) => e.bundleId)).toEqual(["bundle-1"]);
	});

	describe("POST /process", () => {
		it("reports the real outcome when a member PR couldn't be made mergeable", async () => {
			const github = new StubGitHubClient();
			const bundle = makeBundle("bundle-1");
			github.setMergeability(
				bundle.members[0]!.repoOwner,
				bundle.members[0]!.repoName,
				bundle.members[0]!.number,
				{ state: "blocked", isFork: false, merged: false, headBranch: "feature", headSha: "h", baseBranch: "main", baseSha: "b" },
			);
			const localQueue = new MergeQueue(join(dataDir, "queue2.json"), github, new LlmProviderHolder(new StubLlmProvider()), join(dataDir, "conflict.ndjson"));
			await localQueue.load();
			await localQueue.enqueue(bundle);

			const localApp = express();
			localApp.use(express.json());
			localApp.use("/queue", queueRouter(localQueue, state, decidedStore));
			const localServer = await new Promise<Server>((resolve) => {
				const s = localApp.listen(0, () => resolve(s));
			});
			const address = localServer.address();
			if (address === null || typeof address === "string") throw new Error("expected AddressInfo");

			const res = await fetch(`http://127.0.0.1:${address.port}/queue/process`, { method: "POST" });
			const body = (await res.json()) as { status: string; bundleId: string; conflict?: { reason: string } };

			expect(body.status).toBe("conflict");
			expect(body.conflict?.reason).toContain("branch protection");

			await new Promise<void>((resolve) => localServer.close(() => resolve()));
		});
	});

	describe("POST /:bundleId/retry", () => {
		it("returns 400 when the bundle isn't in a conflict state", async () => {
			await queue.enqueue(makeBundle("bundle-1"));

			const res = await fetch(`${baseUrl}/queue/bundle-1/retry`, { method: "POST" });

			expect(res.status).toBe(400);
		});

		it("requeues a conflicted bundle", async () => {
			const github = new StubGitHubClient();
			const bundle = makeBundle("bundle-1");
			github.setMergeability(
				bundle.members[0]!.repoOwner,
				bundle.members[0]!.repoName,
				bundle.members[0]!.number,
				{ state: "blocked", isFork: false, merged: false, headBranch: "feature", headSha: "h", baseBranch: "main", baseSha: "b" },
			);
			const localQueue = new MergeQueue(join(dataDir, "queue3.json"), github, new LlmProviderHolder(new StubLlmProvider()), join(dataDir, "conflict.ndjson"));
			await localQueue.load();
			await localQueue.enqueue(bundle);
			await localQueue.dequeueNext();

			const localApp = express();
			localApp.use(express.json());
			localApp.use("/queue", queueRouter(localQueue, state, decidedStore));
			const localServer = await new Promise<Server>((resolve) => {
				const s = localApp.listen(0, () => resolve(s));
			});
			const address = localServer.address();
			if (address === null || typeof address === "string") throw new Error("expected AddressInfo");

			const res = await fetch(`http://127.0.0.1:${address.port}/queue/bundle-1/retry`, { method: "POST" });
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ status: "queued", bundleId: "bundle-1" });

			const entry = await localQueue.getEntry("bundle-1");
			expect(entry?.status).toBe("queued");
			expect(entry?.conflict).toBeUndefined();

			await new Promise<void>((resolve) => localServer.close(() => resolve()));
		});
	});
});
