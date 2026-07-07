import { describe, it, expect, afterEach } from "@jest/globals";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServerState, hydrateShelf, saveShelf } from "../../src/interface/server/state.js";
import type { Bundle, ReviewCard } from "../../src/engine/types/core.js";

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

describe("shelf persistence", () => {
	let dir: string;

	afterEach(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	it("survives a process restart: a saved shelf reappears after hydrating a fresh state from the same file", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-shelf-persist-"));
		const shelfPath = join(dir, "shelf.json");

		const before = createServerState();
		before.shelf.set("b-1", { card: makeCard("b-1"), bundle: makeBundle("b-1"), memberPrIds: ["pr-1"] });
		await saveShelf(before.shelf, shelfPath);

		// Simulates a restart: a brand new, empty ServerState instead of reusing `before`.
		const after = createServerState();
		await hydrateShelf(after.shelf, shelfPath);

		expect(after.shelf.get("b-1")).toEqual({ card: makeCard("b-1"), bundle: makeBundle("b-1"), memberPrIds: ["pr-1"] });
	});

	it("hydrating from a path with no file yet leaves the shelf empty", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-shelf-persist-"));
		const state = createServerState();

		await hydrateShelf(state.shelf, join(dir, "shelf.json"));

		expect(state.shelf.size).toBe(0);
	});

	it("saving an empty shelf then hydrating from it yields an empty shelf", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-shelf-persist-"));
		const shelfPath = join(dir, "shelf.json");
		const before = createServerState();
		before.shelf.set("b-1", { card: makeCard("b-1"), memberPrIds: ["pr-1"] });
		await saveShelf(before.shelf, shelfPath);

		before.shelf.clear();
		await saveShelf(before.shelf, shelfPath);

		const after = createServerState();
		await hydrateShelf(after.shelf, shelfPath);
		expect(after.shelf.size).toBe(0);
	});
});
