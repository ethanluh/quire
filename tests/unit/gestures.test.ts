import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
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
import type { Bundle, ReviewCard } from "../../src/engine/types/core.js";

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

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "quire-test-"));
		state = createServerState();
		const queue = new MergeQueue(join(dataDir, "queue.json"), new StubGitHubClient());
		await queue.load();

		const app = express();
		app.use(express.json());
		app.use("/bundles", bundlesRouter(state));
		app.use("/bundles", gesturesRouter(state, queue, join(dataDir, "defers.ndjson")));

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
});
