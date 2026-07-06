import { describe, it, expect, afterEach } from "@jest/globals";
import express from "express";
import type { Server } from "node:http";
import { bundlesRouter } from "../../src/interface/server/routes/bundles.js";
import { createServerState } from "../../src/interface/server/state.js";
import type { Bundle, ReviewCard } from "../../src/engine/types/core.js";

function makeCard(bundleId: string): ReviewCard {
	return {
		bundleId,
		directionSummary: "add passwordless auth",
		repoOwner: "org",
		repoName: "repo",
		blastRadius: 1,
		flags: [],
		drift: { status: "clean" },
		residualDisclosure: "behavioral confirm not run",
		inputsHash: "hash-1",
		memberCount: 1,
		requiresAcceptConfirmation: false,
	};
}

function makeBundle(id: string, filesTouched: ReadonlyArray<string> = []): Bundle {
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
				filesTouched,
				symbolsTouched: [],
				testNamesChanged: [],
				ciStatus: "success",
			},
		],
	};
}

describe("bundlesRouter — GET /:id", () => {
	let server: Server;

	afterEach(async () => {
		if (server) await new Promise((resolve) => server.close(resolve));
	});

	function setup() {
		const state = createServerState();
		const app = express();
		app.use("/bundles", bundlesRouter(state));
		server = app.listen(0);
		return { state };
	}

	async function call(path: string): Promise<{ status: number; body: unknown }> {
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("no address");
		const res = await fetch(`http://127.0.0.1:${address.port}${path}`);
		return { status: res.status, body: await res.json() };
	}

	it("returns the card merged with the bundle's members and effectSummary for a review-queue bundle", async () => {
		const { state } = setup();
		state.bundles.set("b-1", makeBundle("b-1"));
		state.cards.set("b-1", makeCard("b-1"));
		await new Promise((resolve) => server.once("listening", resolve));

		const { status, body } = await call("/bundles/b-1");

		expect(status).toBe(200);
		expect(body).toEqual({
			...makeCard("b-1"),
			effectSummary: "adds OTP-based login",
			members: makeBundle("b-1").members,
		});
	});

	it("returns the shelved card and bundle for a deferred bundle", async () => {
		const { state } = setup();
		state.shelf.set("b-2", { card: makeCard("b-2"), bundle: makeBundle("b-2"), memberPrIds: ["b-2-pr-1"] });
		await new Promise((resolve) => server.once("listening", resolve));

		const { status, body } = await call("/bundles/b-2");

		expect(status).toBe(200);
		expect(body).toEqual({
			...makeCard("b-2"),
			effectSummary: "adds OTP-based login",
			members: makeBundle("b-2").members,
		});
	});

	it("returns 404 for an unknown bundle id", async () => {
		setup();
		await new Promise((resolve) => server.once("listening", resolve));

		const { status, body } = await call("/bundles/missing");

		expect(status).toBe(404);
		expect(body).toEqual({ error: "Bundle not found" });
	});

	it("includes assignment fields when the bundle is assigned", async () => {
		const { state } = setup();
		state.bundles.set("b-3", { ...makeBundle("b-3"), assignedTo: "alice", assignedAt: "2026-01-01T00:00:00.000Z", assignedBy: "alice" });
		state.cards.set("b-3", makeCard("b-3"));
		await new Promise((resolve) => server.once("listening", resolve));

		const { body } = await call("/bundles/b-3");

		expect(body).toMatchObject({ assignedTo: "alice", assignedAt: "2026-01-01T00:00:00.000Z", assignedBy: "alice" });
	});
});

describe("bundlesRouter — GET /", () => {
	let server: Server;

	afterEach(async () => {
		if (server) await new Promise((resolve) => server.close(resolve));
	});

	it("includes assignedTo/assignedAt on each card when the underlying bundle is assigned", async () => {
		const state = createServerState();
		state.bundles.set("b-1", { ...makeBundle("b-1"), assignedTo: "bob", assignedAt: "2026-01-01T00:00:00.000Z", assignedBy: "bob" });
		state.cards.set("b-1", makeCard("b-1"));
		const app = express();
		app.use("/bundles", bundlesRouter(state));
		server = app.listen(0);
		await new Promise((resolve) => server.once("listening", resolve));

		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("no address");
		const res = await fetch(`http://127.0.0.1:${address.port}/bundles`);
		const body = (await res.json()) as ReadonlyArray<Record<string, unknown>>;

		expect(body).toEqual([expect.objectContaining({ bundleId: "b-1", assignedTo: "bob", assignedAt: "2026-01-01T00:00:00.000Z" })]);
	});

	it("orders bundles by conflict risk, putting an isolated bundle ahead of ones sharing files", async () => {
		const state = createServerState();
		// "entangled" and "rival" both touch src/shared.ts; "isolated" touches nothing shared.
		state.bundles.set("entangled", makeBundle("entangled", ["src/shared.ts"]));
		state.cards.set("entangled", makeCard("entangled"));
		state.bundles.set("isolated", makeBundle("isolated", ["src/only.ts"]));
		state.cards.set("isolated", makeCard("isolated"));
		state.bundles.set("rival", makeBundle("rival", ["src/shared.ts"]));
		state.cards.set("rival", makeCard("rival"));
		const app = express();
		app.use("/bundles", bundlesRouter(state));
		server = app.listen(0);
		await new Promise((resolve) => server.once("listening", resolve));

		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("no address");
		const res = await fetch(`http://127.0.0.1:${address.port}/bundles`);
		const body = (await res.json()) as ReadonlyArray<{ bundleId: string }>;

		expect(body[0]?.bundleId).toBe("isolated");
	});

	it("breaks a conflict-risk tie by recency, putting the most recently created bundle first", async () => {
		const state = createServerState();
		// Both bundles are equally isolated (zero entanglement, one file each) — a genuine
		// tie on conflict risk, so the tiebreak is what's under test here.
		state.bundles.set("old", makeBundle("old", ["src/a.ts"]));
		state.cards.set("old", makeCard("old"));
		state.bundles.set("new", makeBundle("new", ["src/b.ts"]));
		state.cards.set("new", makeCard("new"));
		const app = express();
		app.use("/bundles", bundlesRouter(state));
		server = app.listen(0);
		await new Promise((resolve) => server.once("listening", resolve));

		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("no address");
		const res = await fetch(`http://127.0.0.1:${address.port}/bundles`);
		const body = (await res.json()) as ReadonlyArray<{ bundleId: string }>;

		expect(body.map((c) => c.bundleId)).toEqual(["new", "old"]);
	});
});
