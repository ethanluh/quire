import { describe, it, expect, afterEach } from "@jest/globals";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JudgeActionStore, loadJudgeActionStore } from "../../src/engine/judge/judgeActionStore.js";
import type { JudgeActionRecord } from "../../src/engine/types/judge.js";

function makeRecord(overrides: Partial<JudgeActionRecord> = {}): JudgeActionRecord {
	return {
		bundleId: "bundle-1",
		inputsHash: "hash-1",
		gesture: "accept",
		status: "merging",
		directionSummary: "add passwordless auth",
		rationale: "clean extension of an accepted precedent",
		startedAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

describe("JudgeActionStore", () => {
	let dir: string;

	afterEach(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	it("finds a saved record by exact (bundleId, inputsHash)", async () => {
		const store = new JudgeActionStore();
		await store.save(makeRecord());
		expect(store.find("bundle-1", "hash-1")).toEqual(makeRecord());
		expect(store.find("bundle-1", "hash-2")).toBeUndefined();
	});

	it("replaces the prior record for a bundleId when re-saved", async () => {
		const store = new JudgeActionStore();
		await store.save(makeRecord({ status: "merging" }));
		await store.save(makeRecord({ status: "verified" }));
		expect(store.list()).toHaveLength(1);
		expect(store.find("bundle-1", "hash-1")?.status).toBe("verified");
	});

	it("lists only entries currently awaiting verification", async () => {
		const store = new JudgeActionStore();
		await store.save(makeRecord({ bundleId: "a", status: "awaitingVerification" }));
		await store.save(makeRecord({ bundleId: "b", status: "verified" }));
		await store.save(makeRecord({ bundleId: "c", status: "awaitingVerification" }));

		const pending = store.listAwaitingVerification();
		expect(pending.map((r) => r.bundleId).sort()).toEqual(["a", "c"]);
	});

	it("persists across a reload from disk", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-judge-actions-"));
		const path = join(dir, "judge-actions.json");
		const store = await loadJudgeActionStore(path);
		await store.save(makeRecord());

		const reloaded = await loadJudgeActionStore(path);
		expect(reloaded.find("bundle-1", "hash-1")).toEqual(makeRecord());
	});

	it("serializes concurrent saves without losing either write", async () => {
		const store = new JudgeActionStore();
		await Promise.all([
			store.save(makeRecord({ bundleId: "bundle-a" })),
			store.save(makeRecord({ bundleId: "bundle-b" })),
		]);
		expect(store.list()).toHaveLength(2);
	});
});
