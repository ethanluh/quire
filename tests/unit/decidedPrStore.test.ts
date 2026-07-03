import { describe, it, expect, afterEach } from "@jest/globals";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DecidedPrStore } from "../../src/engine/queue/decidedPrStore.js";

describe("DecidedPrStore", () => {
	let dir: string;

	afterEach(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	it("reports a PR as not decided before it's ever marked", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-decided-"));
		const store = new DecidedPrStore(join(dir, "decided-prs.json"));
		await store.load();

		expect(store.isDecided("pr-1")).toBe(false);
	});

	it("marks PRs as decided and persists across a fresh instance on the same path", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-decided-"));
		const path = join(dir, "decided-prs.json");
		const store = new DecidedPrStore(path);
		await store.load();

		await store.markDecided(["pr-1", "pr-2"], "reject", { decidedBy: "alice", bundleId: "bundle-1" });

		expect(store.isDecided("pr-1")).toBe(true);
		expect(store.isDecided("pr-2")).toBe(true);
		expect(store.isDecided("pr-3")).toBe(false);

		const reloaded = new DecidedPrStore(path);
		await reloaded.load();
		expect(reloaded.isDecided("pr-1")).toBe(true);
	});

	it("overwrites an existing entry's action when the same PR is decided again", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-decided-"));
		const store = new DecidedPrStore(join(dir, "decided-prs.json"));
		await store.load();

		await store.markDecided(["pr-1"], "defer", { decidedBy: "alice", bundleId: "bundle-1" });
		await store.markDecided(["pr-1"], "reject", { decidedBy: "alice", bundleId: "bundle-1" });

		expect(store.isDecided("pr-1")).toBe(true);
	});

	it("clearDecided removes an entry so the PR is no longer considered decided", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-decided-"));
		const store = new DecidedPrStore(join(dir, "decided-prs.json"));
		await store.load();
		await store.markDecided(["pr-1"], "defer", { decidedBy: "alice", bundleId: "bundle-1" });

		await store.clearDecided("pr-1");

		expect(store.isDecided("pr-1")).toBe(false);
	});

	it("clearDecided is a no-op for a PR that was never decided", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-decided-"));
		const store = new DecidedPrStore(join(dir, "decided-prs.json"));
		await store.load();

		await expect(store.clearDecided("never-decided")).resolves.toBeUndefined();
	});

	it("clearAll wipes every decided entry and persists the empty state", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-decided-"));
		const path = join(dir, "decided-prs.json");
		const store = new DecidedPrStore(path);
		await store.load();
		await store.markDecided(["pr-1", "pr-2"], "reject", { decidedBy: "alice", bundleId: "bundle-1" });

		await store.clearAll();

		expect(store.isDecided("pr-1")).toBe(false);
		expect(store.isDecided("pr-2")).toBe(false);

		const reloaded = new DecidedPrStore(path);
		await reloaded.load();
		expect(reloaded.isDecided("pr-1")).toBe(false);
	});

	it("persists and round-trips the decision audit fields", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-decided-"));
		const path = join(dir, "decided-prs.json");
		const store = new DecidedPrStore(path);
		await store.load();

		await store.markDecided(["pr-1"], "accept", {
			decidedBy: "bob",
			bundleId: "bundle-7",
			wasAssignedTo: "alice",
			overrodeAssignment: true,
		});

		const reloaded = new DecidedPrStore(path);
		await reloaded.load();
		expect(reloaded.isDecided("pr-1")).toBe(true);

		const raw = JSON.parse(await readFile(path, "utf8")) as { entries: ReadonlyArray<Record<string, unknown>> };
		const entry = raw.entries.find((e) => e["prId"] === "pr-1");
		expect(entry).toMatchObject({
			decidedBy: "bob",
			bundleId: "bundle-7",
			wasAssignedTo: "alice",
			overrodeAssignment: true,
		});
	});

	it("treats a corrupted state file as empty instead of throwing", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-decided-"));
		const path = join(dir, "decided-prs.json");
		await writeFile(path, "not json", "utf8");

		const store = new DecidedPrStore(path);
		await store.load();

		expect(store.isDecided("pr-1")).toBe(false);
	});
});
