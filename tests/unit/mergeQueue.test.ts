import { describe, it, expect, afterEach } from "@jest/globals";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MergeQueue } from "../../src/engine/queue/mergeQueue.js";
import { StubGitHubClient } from "../../src/engine/github/stubClient.js";
import type { Bundle } from "../../src/engine/types/core.js";

function makeBundle(id: string): Bundle {
	return {
		id,
		direction: "add passwordless auth",
		effectSummary: "adds OTP-based login",
		members: [],
	};
}

describe("MergeQueue.clear", () => {
	let dir: string;

	afterEach(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	it("empties in-memory entries and persists the empty state to disk", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-queue-"));
		const statePath = join(dir, "queue.json");
		const queue = new MergeQueue(statePath, new StubGitHubClient());
		await queue.load();

		await queue.enqueue(makeBundle("bundle-1"));
		expect(await queue.listEntries()).toHaveLength(1);

		await queue.clear();
		expect(await queue.listEntries()).toHaveLength(0);

		const persisted = JSON.parse(await readFile(statePath, "utf8"));
		expect(persisted.entries).toEqual([]);
	});
});

describe("MergeQueue.removeQueued", () => {
	let dir: string;

	afterEach(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	it("removes an entry that is still queued", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-queue-"));
		const statePath = join(dir, "queue.json");
		const queue = new MergeQueue(statePath, new StubGitHubClient());
		await queue.load();

		await queue.enqueue(makeBundle("bundle-1"));
		await queue.removeQueued("bundle-1");

		expect(await queue.listEntries()).toHaveLength(0);
		const persisted = JSON.parse(await readFile(statePath, "utf8"));
		expect(persisted.entries).toEqual([]);
	});

	it("does not remove an entry that has started landing", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-queue-"));
		const statePath = join(dir, "queue.json");
		const queue = new MergeQueue(statePath, new StubGitHubClient());
		await queue.load();

		await queue.enqueue(makeBundle("bundle-1"));
		await queue.dequeueNext(); // lands bundle-1 (StubGitHubClient merges are no-ops)

		await queue.removeQueued("bundle-1");

		expect(await queue.listEntries()).toHaveLength(1);
	});

	it("silently no-ops when the bundle is not in the queue", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-queue-"));
		const statePath = join(dir, "queue.json");
		const queue = new MergeQueue(statePath, new StubGitHubClient());
		await queue.load();

		await expect(queue.removeQueued("missing-bundle")).resolves.toBeUndefined();
	});
});
