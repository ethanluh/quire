import { describe, it, expect, afterEach } from "@jest/globals";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import type { Server } from "node:http";
import { shelfRouter } from "../../src/interface/server/routes/shelf.js";
import { createServerState } from "../../src/interface/server/state.js";
import { DecidedPrStore } from "../../src/engine/queue/decidedPrStore.js";
import type { Bundle, ReviewCard } from "../../src/engine/types/core.js";

function makeCard(bundleId: string): ReviewCard {
	return {
		bundleId,
		directionSummary: "add passwordless auth",
		blastRadius: 1,
		flags: [],
		drift: { status: "clean" },
		residualDisclosure: "behavioral confirm not run",
		inputsHash: "hash-1",
	};
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

describe("shelfRouter", () => {
	let dir: string;
	let server: Server;

	afterEach(async () => {
		if (server) await new Promise((resolve) => server.close(resolve));
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	function setup() {
		const state = createServerState();
		const decidedStore = new DecidedPrStore(join(dir, "decided-prs.json"));
		const app = express();
		app.use("/shelf", shelfRouter(state, decidedStore));
		server = app.listen(0);
		return { state, decidedStore };
	}

	async function call(method: string, path: string): Promise<{ status: number; body: unknown }> {
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("no address");
		const res = await fetch(`http://127.0.0.1:${address.port}${path}`, { method });
		return { status: res.status, body: await res.json() };
	}

	it("GET returns just the cards, not the internal memberPrIds wrapper", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-shelf-"));
		const { state } = setup();
		state.shelf.set("b-1", { card: makeCard("b-1"), memberPrIds: ["pr-1"] });
		await new Promise((resolve) => server.once("listening", resolve));

		const { body } = await call("GET", "/shelf");

		expect(body).toEqual([makeCard("b-1")]);
	});

	it("promoting a bundle moves its card back to review and clears its members' decided status", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-shelf-"));
		const { state, decidedStore } = setup();
		await new Promise((resolve) => server.once("listening", resolve));
		await decidedStore.markDecided(["pr-1", "pr-2"], "defer");
		state.shelf.set("b-1", { card: makeCard("b-1"), memberPrIds: ["pr-1", "pr-2"] });

		const { status, body } = await call("DELETE", "/shelf/b-1");

		expect(status).toBe(200);
		expect(body).toEqual({ status: "promoted", bundleId: "b-1" });
		expect(state.cards.get("b-1")).toEqual(makeCard("b-1"));
		expect(state.shelf.has("b-1")).toBe(false);
		expect(decidedStore.isDecided("pr-1")).toBe(false);
		expect(decidedStore.isDecided("pr-2")).toBe(false);
	});

	it("promoting a bundle also restores its full Bundle to state.bundles", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-shelf-"));
		const { state } = setup();
		await new Promise((resolve) => server.once("listening", resolve));
		state.shelf.set("b-2", { card: makeCard("b-2"), bundle: makeBundle("b-2"), memberPrIds: ["pr-1"] });

		const { status } = await call("DELETE", "/shelf/b-2");

		expect(status).toBe(200);
		expect(state.bundles.get("b-2")).toEqual(makeBundle("b-2"));
	});

	it("returns 404 for promoting a bundle that isn't on the shelf", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-shelf-"));
		setup();
		await new Promise((resolve) => server.once("listening", resolve));

		const { status, body } = await call("DELETE", "/shelf/missing");

		expect(status).toBe(404);
		expect(body).toEqual({ error: "Bundle not found on shelf" });
	});
});
