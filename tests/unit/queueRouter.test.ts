import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import express from "express";
import type { Request, Response, NextFunction } from "express";
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
import { createAccountState } from "../../src/interface/server/accountState.js";
import type { AccountState } from "../../src/interface/server/accountState.js";
import { notifyStateChanged, onStateChanged } from "../../src/interface/server/changeEvents.js";
import type { InstallationAccountState } from "../../src/engine/github/installation.js";
import type { Bundle, ReviewCard } from "../../src/engine/types/core.js";
import type { TeamRole } from "../../src/engine/types/team.js";

// autoMergeOnAccept lives per-repo — attached to "org/repo" (see makeBundle) so tests that
// need it can flip it on without affecting the other repo-scoped tests, matching the fixture
// pattern already used in gestures.test.ts.
function makeAccount(overrides: { autoMergeOnAccept?: boolean } = {}): InstallationAccountState {
	return {
		installations: [{ installationId: 1, accountLogin: "test-user", accountType: "User", boundAt: new Date(0).toISOString() }],
		repos: [{ owner: "org", name: "repo", installationId: 1, addedAt: new Date(0).toISOString(), addedBy: "test-user", ...overrides }],
	};
}

// Real requests run behind resolveMembership, which always sets res.locals.membership
// before reaching this router — this stands in for that, so isolated router tests keep
// exercising the router's own logic instead of 401ing on a precondition it doesn't own.
function stubMembership(role: TeamRole) {
	return (_req: Request, res: Response, next: NextFunction) => {
		res.locals.membership = { teamId: "test-team", role };
		next();
	};
}

function makeBundle(id: string): Bundle {
	return {
		id,
		direction: "add passwordless auth",
		directionInferred: false,
		effectSummary: "adds OTP-based login",
		members: [
			{
				id: `${id}-pr-1`,
				repoOwner: "org",
				repoName: "repo",
				number: 1,
				headSha: "sha-1",
				declaredDirection: "add passwordless auth",
				directionInferred: false,
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
		memberCount: 1,
		requiresAcceptConfirmation: false,
	};
}

describe("queueRouter — DELETE /:bundleId", () => {
	let server: Server;
	let baseUrl: string;
	let dataDir: string;
	let queue: MergeQueue;
	let state: ReturnType<typeof createServerState>;
	let decidedStore: DecidedPrStore;
	let accountState: AccountState;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "quire-test-"));
		queue = new MergeQueue(join(dataDir, "queue.json"), new StubGitHubClient(), new LlmProviderHolder(new StubLlmProvider()), join(dataDir, "conflict.ndjson"));
		await queue.load();
		state = createServerState();
		decidedStore = new DecidedPrStore(join(dataDir, "decided-prs.json"));
		await decidedStore.load();
		accountState = createAccountState(makeAccount());

		const app = express();
		app.use(express.json());
		app.use(stubMembership("owner"));
		app.use("/queue", queueRouter(queue, state, decidedStore, accountState));

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
		await decidedStore.markDecided(["bundle-1-pr-1"], "accept", { decidedBy: "tester", bundleId: "bundle-1" });

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
			localApp.use(stubMembership("owner"));
			localApp.use("/queue", queueRouter(localQueue, state, decidedStore, accountState));
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

		it("notifies state-changed listeners via MergeQueue's own onChanged hook, wired the same way tenant.ts wires it", async () => {
			// Regression: this route used to call notifyStateChanged() itself after every mutating
			// method; now MergeQueue notifies on its own persist() (see mergeQueue.ts's onChanged
			// hook) and the route relies on that. Construct the queue with the hook wired exactly
			// like tenant.ts does, so this test would catch that wiring breaking, not just the
			// hook existing in isolation.
			const localQueue = new MergeQueue(
				join(dataDir, "queue-notify.json"),
				new StubGitHubClient(),
				new LlmProviderHolder(new StubLlmProvider()),
				join(dataDir, "conflict.ndjson"),
				undefined,
				undefined,
				undefined,
				notifyStateChanged,
			);
			await localQueue.load();
			await localQueue.enqueue(makeBundle("bundle-notify"));

			const localApp = express();
			localApp.use(express.json());
			localApp.use(stubMembership("owner"));
			localApp.use("/queue", queueRouter(localQueue, state, decidedStore, accountState));
			const localServer = await new Promise<Server>((resolve) => {
				const s = localApp.listen(0, () => resolve(s));
			});
			const address = localServer.address();
			if (address === null || typeof address === "string") throw new Error("expected AddressInfo");

			const listener = jest.fn();
			const unsubscribe = onStateChanged(listener);
			try {
				await fetch(`http://127.0.0.1:${address.port}/queue/process`, { method: "POST" });
				expect(listener).toHaveBeenCalled();
			} finally {
				unsubscribe();
				await new Promise<void>((resolve) => localServer.close(() => resolve()));
			}
		});
	});

	describe("POST /:bundleId/retry", () => {
		it("returns 400 when the bundle isn't in a conflict or aborted state", async () => {
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
			localApp.use(stubMembership("owner"));
			localApp.use("/queue", queueRouter(localQueue, state, decidedStore, accountState));
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

		it("requeues an aborted bundle", async () => {
			const github = new StubGitHubClient();
			const bundle = makeBundle("bundle-1");
			github.setMergeability(
				bundle.members[0]!.repoOwner,
				bundle.members[0]!.repoName,
				bundle.members[0]!.number,
				{ state: "blocked", isFork: false, merged: false, headBranch: "feature", headSha: "h", baseBranch: "main", baseSha: "b" },
			);
			const localQueue = new MergeQueue(join(dataDir, "queue5.json"), github, new LlmProviderHolder(new StubLlmProvider()), join(dataDir, "conflict.ndjson"));
			await localQueue.load();
			await localQueue.enqueue(bundle);
			await localQueue.dequeueNext();
			await localQueue.abort("bundle-1");

			const localApp = express();
			localApp.use(express.json());
			localApp.use(stubMembership("owner"));
			localApp.use("/queue", queueRouter(localQueue, state, decidedStore, accountState));
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
			expect(entry?.abortedAt).toBeUndefined();

			await new Promise<void>((resolve) => localServer.close(() => resolve()));
		});

		it("also lands the bundle when autoMergeOnAccept is on, without a separate /process call", async () => {
			// Regression: retry used to only clear the conflict, leaving the bundle "queued"
			// until some unrelated trigger (another accept, a webhook, a manual /process)
			// happened to drain it — even with auto-merge on, unlike the webhook's own
			// reattemptForPr path.
			const github = new StubGitHubClient();
			const bundle = makeBundle("bundle-1");
			github.setMergeability(
				bundle.members[0]!.repoOwner,
				bundle.members[0]!.repoName,
				bundle.members[0]!.number,
				{ state: "blocked", isFork: false, merged: false, headBranch: "feature", headSha: "h", baseBranch: "main", baseSha: "b" },
			);
			const localQueue = new MergeQueue(join(dataDir, "queue6.json"), github, new LlmProviderHolder(new StubLlmProvider()), join(dataDir, "conflict.ndjson"));
			await localQueue.load();
			await localQueue.enqueue(bundle);
			await localQueue.dequeueNext();

			const autoMergeAccountState = createAccountState(makeAccount({ autoMergeOnAccept: true }));
			const localApp = express();
			localApp.use(express.json());
			localApp.use(stubMembership("owner"));
			localApp.use("/queue", queueRouter(localQueue, state, decidedStore, autoMergeAccountState));
			const localServer = await new Promise<Server>((resolve) => {
				const s = localApp.listen(0, () => resolve(s));
			});
			const address = localServer.address();
			if (address === null || typeof address === "string") throw new Error("expected AddressInfo");

			github.setMergeability(
				bundle.members[0]!.repoOwner,
				bundle.members[0]!.repoName,
				bundle.members[0]!.number,
				{ state: "clean", isFork: false, merged: false, headBranch: "feature", headSha: "h", baseBranch: "main", baseSha: "b" },
			);
			const res = await fetch(`http://127.0.0.1:${address.port}/queue/bundle-1/retry`, { method: "POST" });
			expect(res.status).toBe(200);

			const deadline = Date.now() + 1000;
			let entry = await localQueue.getEntry("bundle-1");
			while (entry?.status !== "landed" && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 5));
				entry = await localQueue.getEntry("bundle-1");
			}
			expect(entry?.status).toBe("landed");
			expect(github.mergedPrs).toEqual([`${bundle.members[0]!.repoOwner}/${bundle.members[0]!.repoName}/${bundle.members[0]!.number}`]);

			await new Promise<void>((resolve) => localServer.close(() => resolve()));
		});
	});

	describe("POST /:bundleId/abort", () => {
		it("returns 400 when the bundle isn't in an abortable state", async () => {
			await queue.enqueue(makeBundle("bundle-1"));

			const res = await fetch(`${baseUrl}/queue/bundle-1/abort`, { method: "POST" });

			expect(res.status).toBe(400);
		});

		it("aborts a conflicted bundle without restoring its card to the review queue", async () => {
			const github = new StubGitHubClient();
			const bundle = makeBundle("bundle-1");
			github.setMergeability(
				bundle.members[0]!.repoOwner,
				bundle.members[0]!.repoName,
				bundle.members[0]!.number,
				{ state: "blocked", isFork: false, merged: false, headBranch: "feature", headSha: "h", baseBranch: "main", baseSha: "b" },
			);
			const localQueue = new MergeQueue(join(dataDir, "queue4.json"), github, new LlmProviderHolder(new StubLlmProvider()), join(dataDir, "conflict.ndjson"));
			await localQueue.load();
			await localQueue.enqueue(bundle, makeCard("bundle-1"));
			await localQueue.dequeueNext();

			const localApp = express();
			localApp.use(express.json());
			localApp.use(stubMembership("owner"));
			localApp.use("/queue", queueRouter(localQueue, state, decidedStore, accountState));
			const localServer = await new Promise<Server>((resolve) => {
				const s = localApp.listen(0, () => resolve(s));
			});
			const address = localServer.address();
			if (address === null || typeof address === "string") throw new Error("expected AddressInfo");

			const res = await fetch(`http://127.0.0.1:${address.port}/queue/bundle-1/abort`, { method: "POST" });
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ status: "aborted", bundleId: "bundle-1" });

			const entry = await localQueue.getEntry("bundle-1");
			expect(entry?.status).toBe("aborted");
			expect(entry?.conflict).toBeUndefined();
			expect(state.cards.has("bundle-1")).toBe(false);

			await new Promise<void>((resolve) => localServer.close(() => resolve()));
		});
	});

	describe("role gating", () => {
		async function makeAppAs(role: TeamRole): Promise<{ baseUrl: string; server: Server }> {
			const app = express();
			app.use(express.json());
			app.use(stubMembership(role));
			app.use("/queue", queueRouter(queue, state, decidedStore, accountState));
			const localServer = await new Promise<Server>((resolve) => {
				const s = app.listen(0, () => resolve(s));
			});
			const address = localServer.address();
			if (address === null || typeof address === "string") throw new Error("expected AddressInfo");
			return { baseUrl: `http://127.0.0.1:${address.port}`, server: localServer };
		}

		it.each<TeamRole>(["admin", "member"])("rejects %s from POST /process, retry, abort, revert, and remove", async (role) => {
			await queue.enqueue(makeBundle("bundle-1"));
			const { baseUrl: roleBaseUrl, server: roleServer } = await makeAppAs(role);

			const process = await fetch(`${roleBaseUrl}/queue/process`, { method: "POST" });
			const retry = await fetch(`${roleBaseUrl}/queue/bundle-1/retry`, { method: "POST" });
			const abort = await fetch(`${roleBaseUrl}/queue/bundle-1/abort`, { method: "POST" });
			const revert = await fetch(`${roleBaseUrl}/queue/bundle-1/prs/bundle-1-pr-1`, { method: "DELETE" });
			const remove = await fetch(`${roleBaseUrl}/queue/bundle-1`, { method: "DELETE" });

			expect(process.status).toBe(403);
			expect(retry.status).toBe(403);
			expect(abort.status).toBe(403);
			expect(revert.status).toBe(403);
			expect(remove.status).toBe(403);

			await new Promise<void>((resolve) => roleServer.close(() => resolve()));
		});

		it("still allows GET / (read-only) for a member", async () => {
			const { baseUrl: roleBaseUrl, server: roleServer } = await makeAppAs("member");

			const res = await fetch(`${roleBaseUrl}/queue`);
			expect(res.status).toBe(200);

			await new Promise<void>((resolve) => roleServer.close(() => resolve()));
		});
	});
});
