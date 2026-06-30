import { describe, it, expect, beforeEach } from "@jest/globals";
import { runGate } from "../../src/gate/gate.js";
import { AuditStore } from "../../src/gate/auditStore.js";
import type { PullRequest } from "../../src/types/core.js";
import type { GateConfig } from "../../src/types/gate.js";

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

describe("runGate", () => {
	let audit: AuditStore;

	beforeEach(() => { audit = new AuditStore(); });

	it("passes a PR with no criteria configured", () => {
		const config: GateConfig = { criteria: [] };
		const result = runGate(makePR(), config, audit);
		expect(result.outcome.result).toBe("pass");
	});

	it("enforces buildFailure for a failing PR", () => {
		const config: GateConfig = { criteria: [{ name: "buildFailure", mode: "enforce" }] };
		const result = runGate(makePR({ ciStatus: "failure" }), config, audit);
		expect(result.outcome.result).toBe("reject");
	});

	it("shadows (not rejects) in shadow mode", () => {
		const config: GateConfig = { criteria: [{ name: "buildFailure", mode: "shadow" }] };
		const result = runGate(makePR({ ciStatus: "failure" }), config, audit);
		expect(result.outcome.result).toBe("shadow");
		expect(audit.list()).toHaveLength(1);
	});

	it("skips the criterion in off mode", () => {
		const config: GateConfig = { criteria: [{ name: "buildFailure", mode: "off" }] };
		const result = runGate(makePR({ ciStatus: "failure" }), config, audit);
		expect(result.outcome.result).toBe("pass");
	});

	it("rejects duplicate PRs in enforce mode", () => {
		const config: GateConfig = { criteria: [{ name: "duplicate", mode: "enforce" }] };
		const existing = [makePR({ id: "pr-0" })];
		const result = runGate(makePR({ id: "pr-1" }), config, audit, existing);
		expect(result.outcome.result).toBe("reject");
	});
});
