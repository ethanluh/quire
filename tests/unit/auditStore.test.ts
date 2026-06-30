import { describe, it, expect, afterEach } from "@jest/globals";
import { mkdtemp, rm, readFile } from "node:fs/promises";
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
		declaredDirection: "add passwordless auth",
		diff: { raw: "", hunks: [] },
		filesTouched: ["src/auth.ts"],
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

	it("appends audit records to the NDJSON log as they're added", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-audit-"));
		const logPath = join(dir, "audit.ndjson");
		const store = new AuditStore(logPath);

		await store.add(makePR({ id: "pr-1" }), "duplicate", "looks like a dup");
		await store.add(makePR({ id: "pr-2" }), "outOfScope", "touches unrelated module");

		const lines = (await readFile(logPath, "utf8")).trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0] ?? "")).toMatchObject({ criterionName: "duplicate" });
		expect(JSON.parse(lines[1] ?? "")).toMatchObject({ criterionName: "outOfScope" });
	});

	it("survives a simulated process restart by re-instantiating from the log", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-audit-"));
		const logPath = join(dir, "audit.ndjson");

		const before = new AuditStore(logPath);
		await before.add(makePR({ id: "pr-1" }), "duplicate", "looks like a dup");
		await before.add(makePR({ id: "pr-2" }), "outOfScope", "touches unrelated module");
		expect(before.list()).toHaveLength(2);

		// Simulate restart: no in-memory state carries over, only the log on disk.
		const after = await loadAuditStore(logPath);
		expect(after.list()).toHaveLength(2);
		expect(after.list().map((e) => e.criterionName)).toEqual(["duplicate", "outOfScope"]);

		// And the rebuilt store keeps appending to the same log.
		await after.add(makePR({ id: "pr-3" }), "buildFailure", "ci red");
		const restartedAgain = await loadAuditStore(logPath);
		expect(restartedAgain.list()).toHaveLength(3);
	});

	it("loadAuditStore returns an empty in-memory-only store when no path is given", async () => {
		const store = await loadAuditStore();
		expect(store.list()).toHaveLength(0);
		await store.add(makePR(), "duplicate", "looks like a dup");
		expect(store.list()).toHaveLength(1);
	});

	it("clear() truncates the persisted log so a restart doesn't resurrect cleared entries", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-audit-"));
		const logPath = join(dir, "audit.ndjson");

		const store = new AuditStore(logPath);
		await store.add(makePR(), "duplicate", "looks like a dup");

		await store.clear();
		expect(store.list()).toHaveLength(0);
		expect(await readFile(logPath, "utf8")).toBe("");

		const reloaded = await loadAuditStore(logPath);
		expect(reloaded.list()).toHaveLength(0);
	});
});
