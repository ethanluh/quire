import { describe, it, expect, afterEach } from "@jest/globals";
import { mkdtemp, rm, readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditStore, loadAuditStore } from "../../src/engine/gate/auditStore.js";
import type { PullRequest } from "../../src/engine/types/core.js";

function makePR(overrides: Partial<PullRequest> = {}): PullRequest {
	return {
		id: "pr-1",
		repoOwner: "org",
		repoName: "repo",
		number: 1,
		headSha: "sha-1",
		declaredDirection: "add passwordless auth",
		directionInferred: false,
		diff: { raw: "", hunks: [] },
		filesTouched: ["src/auth.ts"],
		labels: [],
		assignees: [],
		symbolsTouched: [],
		testNamesChanged: [],
		ciStatus: "success",
		...overrides,
	};
}

describe("AuditStore persistence", () => {
	let dir: string;

	afterEach(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	it("persists audit records to the state file as they're added", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-audit-"));
		const statePath = join(dir, "audit.json");
		const store = new AuditStore(statePath);

		await store.add(makePR({ id: "pr-1" }), "duplicate", "looks like a dup");
		await store.add(makePR({ id: "pr-2" }), "outOfScope", "touches unrelated module");

		const persisted: { entries: unknown[] } = JSON.parse(await readFile(statePath, "utf8"));
		expect(persisted.entries).toHaveLength(2);
		expect(persisted.entries[0]).toMatchObject({ criterionName: "duplicate" });
		expect(persisted.entries[1]).toMatchObject({ criterionName: "outOfScope" });
	});

	it("survives a simulated process restart by re-instantiating from the state file", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-audit-"));
		const statePath = join(dir, "audit.json");

		const before = new AuditStore(statePath);
		await before.add(makePR({ id: "pr-1" }), "duplicate", "looks like a dup");
		await before.add(makePR({ id: "pr-2" }), "outOfScope", "touches unrelated module");
		expect(before.list()).toHaveLength(2);

		// Simulate restart: no in-memory state carries over, only the file on disk.
		const after = await loadAuditStore(statePath);
		expect(after.list()).toHaveLength(2);
		expect(after.list().map((e) => e.criterionName)).toEqual(["duplicate", "outOfScope"]);

		// And the rebuilt store keeps persisting to the same file.
		await after.add(makePR({ id: "pr-3" }), "buildFailure", "ci red");
		const restartedAgain = await loadAuditStore(statePath);
		expect(restartedAgain.list()).toHaveLength(3);
	});

	it("loadAuditStore returns an empty in-memory-only store when no path is given", async () => {
		const store = await loadAuditStore();
		expect(store.list()).toHaveLength(0);
		await store.add(makePR(), "duplicate", "looks like a dup");
		expect(store.list()).toHaveLength(1);
	});

	it("clear() empties the persisted state so a restart doesn't resurrect cleared entries", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-audit-"));
		const statePath = join(dir, "audit.json");

		const store = new AuditStore(statePath);
		await store.add(makePR(), "duplicate", "looks like a dup");

		await store.clear();
		expect(store.list()).toHaveLength(0);
		expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual({ entries: [] });

		const reloaded = await loadAuditStore(statePath);
		expect(reloaded.list()).toHaveLength(0);
	});

	it("does not record an entry in memory when the persisted write fails", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-audit-"));
		// A file where a directory component is expected forces the write's mkdir to fail.
		const blockerPath = join(dir, "blocker");
		await writeFile(blockerPath, "not a directory", "utf8");
		const statePath = join(blockerPath, "audit.json");
		const store = new AuditStore(statePath);

		await expect(store.add(makePR(), "duplicate", "looks like a dup")).rejects.toThrow();
		expect(store.list()).toHaveLength(0);
	});

	it("does not clear in-memory entries when the persisted write fails", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-audit-"));
		const statePath = join(dir, "audit.json");
		const store = new AuditStore(statePath);
		await store.add(makePR(), "duplicate", "looks like a dup");

		// Replace the state file with a directory of the same name so the atomic
		// rename onto it structurally fails, regardless of process permissions.
		await unlink(statePath);
		await mkdir(statePath);

		await expect(store.clear()).rejects.toThrow();
		expect(store.list()).toHaveLength(1);
	});

	it("serializes concurrent mutations instead of racing on a stale snapshot", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-audit-"));
		const statePath = join(dir, "audit.json");
		const store = new AuditStore(statePath);
		await store.add(makePR({ id: "pr-1" }), "duplicate", "looks like a dup");
		const [entry] = store.list();

		// Fire an overturn and a fresh add() without awaiting either first — if the two
		// mutations raced on a stale in-memory snapshot (the bug this test guards against),
		// whichever write finished last would silently drop the other's change from disk.
		await Promise.all([
			store.overturn(entry?.id ?? ""),
			store.add(makePR({ id: "pr-2" }), "outOfScope", "touches unrelated module"),
		]);

		expect(store.list()).toHaveLength(2);
		expect(store.list().find((e) => e.id === entry?.id)?.overturnedAt).not.toBeNull();

		const reloaded = await loadAuditStore(statePath);
		expect(reloaded.list()).toHaveLength(2);
		expect(reloaded.list().find((e) => e.id === entry?.id)?.overturnedAt).not.toBeNull();
	});

	it("assigns each entry a unique id", async () => {
		const store = await loadAuditStore();
		await store.add(makePR({ id: "pr-1" }), "duplicate", "looks like a dup");
		await store.add(makePR({ id: "pr-2" }), "duplicate", "looks like a dup");

		const [first, second] = store.list();
		expect(first?.id).toBeTruthy();
		expect(second?.id).toBeTruthy();
		expect(first?.id).not.toBe(second?.id);
		expect(first?.overturnedAt).toBeNull();
	});

	it("overturn() marks the matching entry and persists the rewrite", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-audit-"));
		const statePath = join(dir, "audit.json");
		const store = new AuditStore(statePath);
		await store.add(makePR({ id: "pr-1" }), "duplicate", "looks like a dup");
		const [entry] = store.list();

		const found = await store.overturn(entry?.id ?? "");

		expect(found).toBe(true);
		expect(store.list()[0]?.overturnedAt).not.toBeNull();

		const reloaded = await loadAuditStore(statePath);
		expect(reloaded.list()[0]?.overturnedAt).not.toBeNull();
		expect(reloaded.list()[0]?.id).toBe(entry?.id);
	});

	it("overturn() returns false for an unknown id and leaves entries untouched", async () => {
		const store = await loadAuditStore();
		await store.add(makePR(), "duplicate", "looks like a dup");

		const found = await store.overturn("does-not-exist");

		expect(found).toBe(false);
		expect(store.list()[0]?.overturnedAt).toBeNull();
	});

	it("overturn() is idempotent on an already-overturned entry", async () => {
		const store = await loadAuditStore();
		await store.add(makePR(), "duplicate", "looks like a dup");
		const [entry] = store.list();

		await store.overturn(entry?.id ?? "");
		const firstOverturnedAt = store.list()[0]?.overturnedAt;
		const secondCall = await store.overturn(entry?.id ?? "");

		expect(secondCall).toBe(true);
		expect(store.list()[0]?.overturnedAt).toBe(firstOverturnedAt);
	});
});
