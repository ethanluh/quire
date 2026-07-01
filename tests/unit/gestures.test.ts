import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import express from "express";
import type { Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServerState } from "../../src/interface/server/state.js";
import { bundlesRouter } from "../../src/interface/server/routes/bundles.js";
import { gesturesRouter } from "../../src/interface/server/routes/gestures.js";
import { MergeQueue } from "../../src/engine/queue/mergeQueue.js";
import { StubGitHubClient } from "../../src/engine/github/stubClient.js";
import type { Bundle, GestureAction, ReviewCard } from "../../src/engine/types/core.js";

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

function makeBundle(id: string): Bundle {
	return {
		id,
		direction: "add passwordless auth",
		members: [
			{
				id: `${id}-pr-1`,
				repoOwner: "org",
				repoName: "repo",
				number: 1,
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
	};
}

describe("gesturesRouter — review queue removal", () => {
	let server: Server;
	let baseUrl: string;
	let state: ReturnType<typeof createServerState>;
	let dataDir: string;
	let github: StubGitHubClient;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "quire-test-"));
		state = createServerState();
		github = new StubGitHubClient();
		const queue = new MergeQueue(join(dataDir, "queue.json"), github);
		await queue.load();

		const app = express();
		app.use(express.json());
		app.use("/bundles", bundlesRouter(state));
		app.use("/bundles", gesturesRouter(state, queue, join(dataDir, "defers.ndjson"), github));

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
	});

	it("removes the card from the review queue on reject", async () => {
		state.bundles.set("b-2", makeBundle("b-2"));
		state.cards.set("b-2", makeCard("b-2"));

		await gesture("b-2", "reject");

		const cards = await (await fetch(`${baseUrl}/bundles`)).json();
		expect(cards).toEqual([]);
	});

	it("removes the card from the review queue on defer", async () => {
		state.bundles.set("b-3", makeBundle("b-3"));
		state.cards.set("b-3", makeCard("b-3"));

		await gesture("b-3", "defer");

		const cards = await (await fetch(`${baseUrl}/bundles`)).json();
		expect(cards).toEqual([]);
		expect(state.shelf.has("b-3")).toBe(true);
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
		const queue = new MergeQueue(join(dataDir, "queue.json"), github);
		await queue.load();

		const app = express();
		app.use(express.json());
		app.use("/bundles", gesturesRouter(state, queue, join(dataDir, "defers.ndjson"), github));

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
