import { describe, it, expect, afterEach } from "@jest/globals";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditStore } from "../../src/engine/gate/auditStore.js";
import type { PullRequest } from "../../src/engine/types/core.js";

function makePR(id: string): PullRequest {
	return {
		id,
		repoOwner: "org",
		repoName: "repo",
		number: 1,
		declaredDirection: "add passwordless auth",
		diff: { raw: "", hunks: [] },
		filesTouched: ["src/auth.ts"],
		symbolsTouched: [],
		testNamesChanged: [],
		ciStatus: "success",
	};
}

describe("AuditStore persistence", () => {
	let dir: string;

	afterEach(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	it("survives a simulated restart by reloading from its log file", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-audit-"));
		const logPath = join(dir, "instrumentation", "audit.ndjson");

		const before = new AuditStore(logPath);
		before.add(makePR("pr-1"), "duplicate", "looks like a dup");
		before.add(makePR("pr-2"), "outOfScope", "touches unrelated files");
		await before.flush();

		const after = await AuditStore.load(logPath);
		expect(after.list()).toHaveLength(2);
		expect(after.list().map((e) => e.criterionName)).toEqual(["duplicate", "outOfScope"]);
	});

	it("returns an empty store when the log file does not exist yet", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-audit-"));
		const logPath = join(dir, "instrumentation", "audit.ndjson");

		const store = await AuditStore.load(logPath);
		expect(store.list()).toHaveLength(0);
	});
});
