import { describe, it, expect, afterEach } from "@jest/globals";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JudgeVerdictStore, loadJudgeVerdictStore } from "../../src/engine/judge/judgeVerdictStore.js";
import type { JudgeVerdictRecord } from "../../src/engine/types/judge.js";

function makeRecord(overrides: Partial<JudgeVerdictRecord> = {}): JudgeVerdictRecord {
	return {
		bundleId: "bundle-1",
		inputsHash: "hash-1",
		mode: "shadow",
		computedAt: "2026-01-01T00:00:00.000Z",
		status: "abstained",
		abstainReason: "no real judge LLM configured",
		...overrides,
	};
}

describe("JudgeVerdictStore", () => {
	let dir: string;

	afterEach(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	it("finds a saved record by exact (bundleId, inputsHash)", async () => {
		const store = new JudgeVerdictStore();
		await store.save(makeRecord());
		expect(store.find("bundle-1", "hash-1")).toEqual(makeRecord());
		expect(store.find("bundle-1", "hash-2")).toBeUndefined();
		expect(store.find("bundle-2", "hash-1")).toBeUndefined();
	});

	it("replaces the prior record for a bundleId when re-saved with a new inputsHash", async () => {
		const store = new JudgeVerdictStore();
		await store.save(makeRecord({ inputsHash: "hash-1" }));
		await store.save(makeRecord({ inputsHash: "hash-2" }));
		expect(store.find("bundle-1", "hash-1")).toBeUndefined();
		expect(store.find("bundle-1", "hash-2")).toBeDefined();
		expect(store.list()).toHaveLength(1);
	});

	it("persists across a reload from disk", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-judge-verdicts-"));
		const path = join(dir, "judge-verdicts.json");
		const store = await loadJudgeVerdictStore(path);
		await store.save(makeRecord());

		const reloaded = await loadJudgeVerdictStore(path);
		expect(reloaded.find("bundle-1", "hash-1")).toEqual(makeRecord());
	});

	it("is a no-op-safe in-memory store when constructed with no statePath", async () => {
		const store = new JudgeVerdictStore();
		await store.save(makeRecord());
		expect(store.find("bundle-1", "hash-1")).toBeDefined();
	});

	it("serializes concurrent saves without losing either write", async () => {
		const store = new JudgeVerdictStore();
		await Promise.all([store.save(makeRecord({ bundleId: "bundle-a" })), store.save(makeRecord({ bundleId: "bundle-b" }))]);
		expect(store.find("bundle-a", "hash-1")).toBeDefined();
		expect(store.find("bundle-b", "hash-1")).toBeDefined();
		expect(store.list()).toHaveLength(2);
	});
});
