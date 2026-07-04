import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import express from "express";
import type { Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response, NextFunction } from "express";
import { createServerState } from "../../src/interface/server/state.js";
import { bundlesRouter } from "../../src/interface/server/routes/bundles.js";
import { gesturesRouter } from "../../src/interface/server/routes/gestures.js";
import { assignmentsRouter } from "../../src/interface/server/routes/assignments.js";
import type { TeamRole } from "../../src/engine/types/team.js";
import { MergeQueue } from "../../src/engine/queue/mergeQueue.js";
import { DecidedPrStore } from "../../src/engine/queue/decidedPrStore.js";
import { StubGitHubClient } from "../../src/engine/github/stubClient.js";
import { StubLlmProvider } from "../../src/engine/drift/effectList/stubProvider.js";
import { LlmProviderHolder } from "../../src/engine/drift/effectList/providerHolder.js";
import { createAccountState } from "../../src/interface/server/accountState.js";
import type { AccountState } from "../../src/interface/server/accountState.js";
import type { InstallationAccountState } from "../../src/engine/github/installation.js";
import { errorHandler } from "../../src/interface/server/middleware/errors.js";
import type { Bundle, GestureAction, ReviewCard } from "../../src/engine/types/core.js";
import type { MergeQueueEntry, MergeQueueEntryStatus } from "../../src/engine/types/queue.js";

class RejectingGitHubClient extends StubGitHubClient {
	override async postReviewCardComment(
		_owner: string,
		_repo: string,
		_prNumber: number,
		_action: GestureAction,
		_card: ReviewCard,
	): Promise<void> {
		throw new Error("GitHub API unavailable");
	}
}

class CloseFailingGitHubClient extends StubGitHubClient {
	override async closePullRequest(_owner: string, _repo: string, _prNumber: number): Promise<void> {
		throw new Error("GitHub API unavailable");
	}
}

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

// autoMergeOnAccept lives per-repo now — attached to "org/repo" (see makeBundle) so the
// gating logic's per-bundle repo lookup finds it.
function makeAccount(overrides: { autoMergeOnAccept?: boolean } = {}): InstallationAccountState {
	return {
		installations: [{ installationId: 1, accountLogin: "test-user", accountType: "User", boundAt: new Date(0).toISOString() }],
		repos: [
			{
				owner: "org",
				name: "repo",
				installationId: 1,
				addedAt: new Date(0).toISOString(),
				addedBy: "test-user",
				...overrides,
			},
		],
	};
}

// Auto-merge now runs as a fire-and-forget background call (see gestures.ts), so a test can't
// just await the gesture response to observe its outcome — it has to poll queue state instead.
async function waitForEntryStatus(
	queue: MergeQueue,
	bundleId: string,
	status: MergeQueueEntryStatus,
	timeoutMs = 1000,
): Promise<MergeQueueEntry> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const entry = await queue.getEntry(bundleId);
		if (entry?.status === status) return entry;
		if (Date.now() > deadline) {
			throw new Error(`Timed out waiting for bundle ${bundleId} to reach status "${status}" (last: ${entry?.status})`);
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

// Injects the acting login/role that resolveMembership would normally set, so a test can
// exercise gesture/assignment gating without standing up the real session/membership stack.
// `getActor` is read per-request (not captured once) so a single test can gesture as one
// login then reassign as another.
function actorMiddleware(getActor: () => { login: string; role: TeamRole }) {
	return function (_req: Request, res: Response, next: NextFunction): void {
		const actor = getActor();
		res.locals.login = actor.login;
		res.locals.membership = { teamId: "team-1", role: actor.role };
		next();
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

describe("gesturesRouter — review queue removal", () => {
	let server: Server;
	let baseUrl: string;
	let state: ReturnType<typeof createServerState>;
	let dataDir: string;
	let github: StubGitHubClient;
	let queue: MergeQueue;
	let decidedStore: DecidedPrStore;
	let accountState: AccountState;
	let currentActor: { login: string; role: TeamRole };

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "quire-test-"));
		state = createServerState();
		github = new StubGitHubClient();
		queue = new MergeQueue(join(dataDir, "queue.json"), github, new LlmProviderHolder(new StubLlmProvider()), join(dataDir, "conflict.ndjson"));
		await queue.load();
		decidedStore = new DecidedPrStore(join(dataDir, "decided-prs.json"));
		await decidedStore.load();
		accountState = createAccountState(undefined);
		currentActor = { login: "actor", role: "owner" };

		const app = express();
		app.use(express.json());
		app.use(actorMiddleware(() => currentActor));
		app.use("/bundles", bundlesRouter(state));
		app.use(
			"/bundles",
			gesturesRouter(state, queue, join(dataDir, "defers.ndjson"), github, decidedStore, accountState),
		);
		app.use("/bundles", assignmentsRouter(state));

		await new Promise<void>((resolve) => {
			server = app.listen(0, resolve);
		});
		const address = server.address();
		const port = typeof address === "object" && address !== null ? address.port : 0;
		baseUrl = `http://127.0.0.1:${port}`;
	});

	afterEach(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(dataDir, { recursive: true, force: true });
	});

	async function gesture(bundleId: string, action: "accept" | "defer" | "reject") {
		return fetch(`${baseUrl}/bundles/${bundleId}/gesture`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action }),
		});
	}

	it("removes the card from the review queue on accept", async () => {
		state.bundles.set("b-1", makeBundle("b-1"));
		state.cards.set("b-1", makeCard("b-1"));

		const res = await gesture("b-1", "accept");
		expect(res.status).toBe(200);

		const cards = await (await fetch(`${baseUrl}/bundles`)).json();
		expect(cards).toEqual([]);
		expect(state.bundles.has("b-1")).toBe(false);
		expect(decidedStore.isDecided("b-1-pr-1")).toBe(true);
	});

	it("auto-merges an accepted bundle in the background when autoMergeOnAccept is enabled", async () => {
		accountState.current = makeAccount({ autoMergeOnAccept: true });
		state.bundles.set("b-1b", makeBundle("b-1b"));
		state.cards.set("b-1b", makeCard("b-1b"));

		// gestures.ts fires this in the background without awaiting it (see the comment there),
		// and MergeQueue flips an entry's in-memory status to "landed" before its persist() write
		// finishes — so polling getEntry() alone can observe "landed" while queue.json is still
		// being written. Spying lets us await the real call so the write is guaranteed to have
		// settled before this test (and afterEach's rm(dataDir)) proceeds.
		const dequeueNextSpy = jest.spyOn(queue, "dequeueNext");

		const res = await gesture("b-1b", "accept");

		// The response must not block on the merge itself — same shape as the
		// non-auto-merge path — so the bundle shows up in the queue instantly.
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: "queued", bundleId: "b-1b" });

		// The merge still happens, just in the background.
		const landed = await waitForEntryStatus(queue, "b-1b", "landed");
		expect(landed.status).toBe("landed");
		expect(github.mergedPrs).toEqual(["org/repo/1"]);

		// Wait for the background dequeueNext() call itself (and thus its queue.json
		// persistence) to fully settle before returning control to afterEach.
		await dequeueNextSpy.mock.results[0]?.value;
	});

	it("only enqueues on accept when autoMergeOnAccept is disabled", async () => {
		accountState.current = makeAccount({ autoMergeOnAccept: false });
		state.bundles.set("b-1c", makeBundle("b-1c"));
		state.cards.set("b-1c", makeCard("b-1c"));

		const res = await gesture("b-1c", "accept");

		expect(await res.json()).toEqual({ status: "queued", bundleId: "b-1c" });
		expect(github.mergedPrs).toEqual([]);

		const entries = await queue.listEntries();
		expect(entries[0]?.card).toEqual(makeCard("b-1c"));
	});

	it("removes the card from the review queue on reject", async () => {
		state.bundles.set("b-2", makeBundle("b-2"));
		state.cards.set("b-2", makeCard("b-2"));

		await gesture("b-2", "reject");

		const cards = await (await fetch(`${baseUrl}/bundles`)).json();
		expect(cards).toEqual([]);
		expect(decidedStore.isDecided("b-2-pr-1")).toBe(true);
	});

	it("closes each member PR on GitHub on reject", async () => {
		state.bundles.set("b-2b", makeBundle("b-2b"));
		state.cards.set("b-2b", makeCard("b-2b"));

		await gesture("b-2b", "reject");

		expect(github.closedPrs).toEqual(["org/repo/1"]);
	});

	it("removes the card from the review queue on defer", async () => {
		state.bundles.set("b-3", makeBundle("b-3"));
		state.cards.set("b-3", makeCard("b-3"));

		await gesture("b-3", "defer");

		const cards = await (await fetch(`${baseUrl}/bundles`)).json();
		expect(cards).toEqual([]);
		expect(state.shelf.has("b-3")).toBe(true);
		expect(decidedStore.isDecided("b-3-pr-1")).toBe(true);
	});

	it("keeps the full bundle alongside the card on defer, for the detail view", async () => {
		state.bundles.set("b-3b", makeBundle("b-3b"));
		state.cards.set("b-3b", makeCard("b-3b"));

		await gesture("b-3b", "defer");

		// The shelved bundle carries the self-assign stamp from this gesture, on top of the
		// original bundle fields.
		expect(state.shelf.get("b-3b")?.bundle).toEqual({
			...makeBundle("b-3b"),
			assignedTo: "actor",
			assignedAt: expect.any(String),
			assignedBy: "actor",
		});
	});

	it("posts a review card comment to each member PR on accept", async () => {
		state.bundles.set("b-4", makeBundle("b-4"));
		state.cards.set("b-4", makeCard("b-4"));

		await gesture("b-4", "accept");

		expect(github.postedReviewCardComments).toEqual([
			expect.objectContaining({
				owner: "org",
				repo: "repo",
				prNumber: 1,
				action: "accept",
				card: makeCard("b-4"),
			}),
		]);
	});

	it("posts a review card comment to each member PR on reject", async () => {
		state.bundles.set("b-5", makeBundle("b-5"));
		state.cards.set("b-5", makeCard("b-5"));

		await gesture("b-5", "reject");

		expect(github.postedReviewCardComments).toEqual([
			expect.objectContaining({ owner: "org", repo: "repo", prNumber: 1, action: "reject" }),
		]);
	});

	it("posts a review card comment to each member PR on defer", async () => {
		state.bundles.set("b-6", makeBundle("b-6"));
		state.cards.set("b-6", makeCard("b-6"));

		await gesture("b-6", "defer");

		expect(github.postedReviewCardComments).toEqual([
			expect.objectContaining({ owner: "org", repo: "repo", prNumber: 1, action: "defer" }),
		]);
	});

	it("self-assigns an unassigned bundle to whoever gestures on it", async () => {
		currentActor = { login: "carol", role: "member" };
		state.bundles.set("b-7", makeBundle("b-7"));
		state.cards.set("b-7", makeCard("b-7"));

		await gesture("b-7", "defer");

		const shelved = state.shelf.get("b-7")?.bundle;
		expect(shelved?.assignedTo).toBe("carol");
		expect(shelved?.assignedBy).toBe("carol");
	});

	it("lets the assignee gesture on their own bundle with no gate", async () => {
		const bundle = { ...makeBundle("b-8"), assignedTo: "carol", assignedAt: new Date(0).toISOString(), assignedBy: "carol" };
		state.bundles.set("b-8", bundle);
		state.cards.set("b-8", makeCard("b-8"));
		currentActor = { login: "carol", role: "member" };

		const res = await gesture("b-8", "defer");

		expect(res.status).toBe(200);
	});

	it("blocks a non-privileged member from gesturing on someone else's assigned bundle", async () => {
		const bundle = { ...makeBundle("b-9"), assignedTo: "carol", assignedAt: new Date(0).toISOString(), assignedBy: "carol" };
		state.bundles.set("b-9", bundle);
		state.cards.set("b-9", makeCard("b-9"));
		currentActor = { login: "dave", role: "member" };

		const res = await gesture("b-9", "defer");

		expect(res.status).toBe(403);
		expect(await res.json()).toMatchObject({ assignedTo: "carol" });
		expect(state.bundles.get("b-9")).toEqual(bundle);
	});

	it("409s an admin gesturing on someone else's assigned bundle without force", async () => {
		const bundle = { ...makeBundle("b-10"), assignedTo: "carol", assignedAt: new Date(0).toISOString(), assignedBy: "carol" };
		state.bundles.set("b-10", bundle);
		state.cards.set("b-10", makeCard("b-10"));
		currentActor = { login: "eve", role: "admin" };

		const res = await gesture("b-10", "defer");

		expect(res.status).toBe(409);
		expect(state.bundles.get("b-10")).toEqual(bundle);
	});

	it("lets an admin override someone else's assignment with force=true", async () => {
		const bundle = { ...makeBundle("b-11"), assignedTo: "carol", assignedAt: new Date(0).toISOString(), assignedBy: "carol" };
		state.bundles.set("b-11", bundle);
		state.cards.set("b-11", makeCard("b-11"));
		currentActor = { login: "eve", role: "admin" };

		const res = await fetch(`${baseUrl}/bundles/b-11/gesture?force=true`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "defer" }),
		});

		expect(res.status).toBe(200);
		expect(state.shelf.get("b-11")?.bundle?.assignedTo).toBe("eve");
	});

	it("records decidedBy/bundleId/wasAssignedTo/overrodeAssignment on accept", async () => {
		const bundle = { ...makeBundle("b-12"), assignedTo: "carol", assignedAt: new Date(0).toISOString(), assignedBy: "carol" };
		state.bundles.set("b-12", bundle);
		state.cards.set("b-12", makeCard("b-12"));
		currentActor = { login: "eve", role: "owner" };

		await fetch(`${baseUrl}/bundles/b-12/gesture?force=true`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "accept" }),
		});

		const decided = JSON.parse(await readFile(join(dataDir, "decided-prs.json"), "utf8")) as {
			entries: ReadonlyArray<Record<string, unknown>>;
		};
		const entry = decided.entries.find((e) => e["prId"] === "b-12-pr-1");
		expect(entry).toMatchObject({
			decidedBy: "eve",
			bundleId: "b-12",
			wasAssignedTo: "carol",
			overrodeAssignment: true,
		});
	});
});

describe("assignmentsRouter", () => {
	let server: Server;
	let baseUrl: string;
	let state: ReturnType<typeof createServerState>;
	let currentActor: { login: string; role: TeamRole };

	beforeEach(async () => {
		state = createServerState();
		currentActor = { login: "actor", role: "member" };

		const app = express();
		app.use(express.json());
		app.use(actorMiddleware(() => currentActor));
		app.use("/bundles", assignmentsRouter(state));

		await new Promise<void>((resolve) => {
			server = app.listen(0, resolve);
		});
		const address = server.address();
		const port = typeof address === "object" && address !== null ? address.port : 0;
		baseUrl = `http://127.0.0.1:${port}`;
	});

	afterEach(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	async function assign(bundleId: string, login: string) {
		return fetch(`${baseUrl}/bundles/${bundleId}/assign`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ login }),
		});
	}

	async function unassign(bundleId: string) {
		return fetch(`${baseUrl}/bundles/${bundleId}/assign`, { method: "DELETE" });
	}

	it("lets a member self-assign an unassigned bundle", async () => {
		state.bundles.set("b-1", makeBundle("b-1"));

		const res = await assign("b-1", "actor");

		expect(res.status).toBe(200);
		expect(state.bundles.get("b-1")?.assignedTo).toBe("actor");
	});

	it("403s a member assigning a bundle to someone else", async () => {
		state.bundles.set("b-2", makeBundle("b-2"));

		const res = await assign("b-2", "someone-else");

		expect(res.status).toBe(403);
		expect(state.bundles.get("b-2")?.assignedTo).toBeUndefined();
	});

	it("lets an admin assign a bundle to someone else", async () => {
		currentActor = { login: "admin-actor", role: "admin" };
		state.bundles.set("b-3", makeBundle("b-3"));

		const res = await assign("b-3", "someone-else");

		expect(res.status).toBe(200);
		expect(state.bundles.get("b-3")?.assignedTo).toBe("someone-else");
	});

	it("403s a member reassigning a bundle already assigned to someone else", async () => {
		state.bundles.set("b-4", { ...makeBundle("b-4"), assignedTo: "someone-else" });

		const res = await assign("b-4", "actor");

		expect(res.status).toBe(403);
	});

	it("prefers the 'assign to someone else' 403 when a member both targets a third party and the bundle is already taken", async () => {
		// Both 403 guards apply here: actor is non-privileged, targets a third party ("target"),
		// AND the bundle is already assigned to "owner". The "Only owners/admins can assign a
		// bundle to someone else" guard must win, matching the original route ordering — the
		// assigned-to-someone-else guard runs after it, so its body/assignedTo field must not leak.
		state.bundles.set("b-4b", { ...makeBundle("b-4b"), assignedTo: "owner" });

		const res = await assign("b-4b", "target");

		expect(res.status).toBe(403);
		const body = (await res.json()) as { error: string; assignedTo?: string };
		expect(body.error).toBe("Only owners/admins can assign a bundle to someone else");
		expect(body.assignedTo).toBeUndefined();
	});

	it("lets a member unassign their own bundle", async () => {
		state.bundles.set("b-5", { ...makeBundle("b-5"), assignedTo: "actor" });

		const res = await unassign("b-5");

		expect(res.status).toBe(200);
		expect(state.bundles.get("b-5")?.assignedTo).toBeUndefined();
	});

	it("403s a member unassigning someone else's bundle", async () => {
		state.bundles.set("b-6", { ...makeBundle("b-6"), assignedTo: "someone-else" });

		const res = await unassign("b-6");

		expect(res.status).toBe(403);
		expect(state.bundles.get("b-6")?.assignedTo).toBe("someone-else");
	});

	it("lets an admin unassign someone else's bundle", async () => {
		currentActor = { login: "admin-actor", role: "admin" };
		state.bundles.set("b-7", { ...makeBundle("b-7"), assignedTo: "someone-else" });

		const res = await unassign("b-7");

		expect(res.status).toBe(200);
	});

	it("404s for a bundle that doesn't exist", async () => {
		const res = await assign("does-not-exist", "actor");
		expect(res.status).toBe(404);
	});
});

describe("gesturesRouter — review card comment posting failures", () => {
	let server: Server;
	let baseUrl: string;
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "quire-test-"));
		const state = createServerState();
		state.bundles.set("b-1", makeBundle("b-1"));
		state.cards.set("b-1", makeCard("b-1"));

		const github = new RejectingGitHubClient();
		const queue = new MergeQueue(join(dataDir, "queue.json"), github, new LlmProviderHolder(new StubLlmProvider()), join(dataDir, "conflict.ndjson"));
		await queue.load();
		const decidedStore = new DecidedPrStore(join(dataDir, "decided-prs.json"));
		await decidedStore.load();
		const accountState = createAccountState(undefined);

		const app = express();
		app.use(express.json());
		app.use(actorMiddleware(() => ({ login: "actor", role: "owner" })));
		app.use(
			"/bundles",
			gesturesRouter(state, queue, join(dataDir, "defers.ndjson"), github, decidedStore, accountState),
		);

		await new Promise<void>((resolve) => {
			server = app.listen(0, resolve);
		});
		const address = server.address();
		const port = typeof address === "object" && address !== null ? address.port : 0;
		baseUrl = `http://127.0.0.1:${port}`;
	});

	afterEach(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(dataDir, { recursive: true, force: true });
	});

	it("still returns success and logs the failure when postReviewCardComment rejects", async () => {
		const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

		const res = await fetch(`${baseUrl}/bundles/b-1/gesture`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "accept" }),
		});

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: "queued", bundleId: "b-1" });

		// The rejection is handled by a fire-and-forget .catch(), so let its microtask settle.
		await new Promise((resolve) => setImmediate(resolve));

		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining("Failed to post review card comment to org/repo#1"),
			expect.any(Error),
		);

		errorSpy.mockRestore();
	});
});

describe("gesturesRouter — reject GitHub close failures", () => {
	let server: Server;
	let baseUrl: string;
	let dataDir: string;
	let state: ReturnType<typeof createServerState>;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "quire-test-"));
		state = createServerState();
		state.bundles.set("b-1", makeBundle("b-1"));
		state.cards.set("b-1", makeCard("b-1"));

		const github = new CloseFailingGitHubClient();
		const queue = new MergeQueue(join(dataDir, "queue.json"), github, new LlmProviderHolder(new StubLlmProvider()), join(dataDir, "conflict.ndjson"));
		await queue.load();
		const decidedStore = new DecidedPrStore(join(dataDir, "decided-prs.json"));
		await decidedStore.load();
		const accountState = createAccountState(undefined);

		const app = express();
		app.use(express.json());
		app.use(actorMiddleware(() => ({ login: "actor", role: "owner" })));
		app.use("/bundles", bundlesRouter(state));
		app.use(
			"/bundles",
			gesturesRouter(state, queue, join(dataDir, "defers.ndjson"), github, decidedStore, accountState),
		);
		app.use(errorHandler);

		await new Promise<void>((resolve) => {
			server = app.listen(0, resolve);
		});
		const address = server.address();
		const port = typeof address === "object" && address !== null ? address.port : 0;
		baseUrl = `http://127.0.0.1:${port}`;
	});

	afterEach(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(dataDir, { recursive: true, force: true });
	});

	it("leaves the bundle in the review queue when closing the PR on GitHub fails", async () => {
		const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

		const res = await fetch(`${baseUrl}/bundles/b-1/gesture`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "reject" }),
		});

		expect(res.status).toBeGreaterThanOrEqual(500);

		const cards = await (await fetch(`${baseUrl}/bundles`)).json();
		expect(cards).toEqual([expect.objectContaining({ bundleId: "b-1" })]);

		errorSpy.mockRestore();
	});
});
