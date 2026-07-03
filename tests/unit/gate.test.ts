import { describe, it, expect, beforeEach } from "@jest/globals";
import { runGate } from "../../src/engine/gate/gate.js";
import { AuditStore } from "../../src/engine/gate/auditStore.js";
import { UNDECLARED_DIRECTION, type PullRequest } from "../../src/engine/types/core.js";
import type { GateConfig } from "../../src/engine/types/gate.js";

function makePR(overrides: Partial<PullRequest> = {}): PullRequest {
	return {
		id: "pr-1",
		repoOwner: "org",
		repoName: "repo",
		number: 1,
		headSha: "sha-1",
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

	it("passes a PR with no criteria configured", async () => {
		const config: GateConfig = { criteria: [] };
		const result = await runGate(makePR(), config, audit);
		expect(result.outcome.result).toBe("pass");
	});

	it("enforces buildFailure for a failing PR", async () => {
		const config: GateConfig = { criteria: [{ name: "buildFailure", mode: "enforce" }] };
		const result = await runGate(makePR({ ciStatus: "failure" }), config, audit);
		expect(result.outcome.result).toBe("reject");
	});

	it("shadows (not rejects) in shadow mode", async () => {
		const config: GateConfig = { criteria: [{ name: "buildFailure", mode: "shadow" }] };
		const result = await runGate(makePR({ ciStatus: "failure" }), config, audit);
		expect(result.outcome.result).toBe("shadow");
		expect(audit.list()).toHaveLength(1);
	});

	it("skips the criterion in off mode", async () => {
		const config: GateConfig = { criteria: [{ name: "buildFailure", mode: "off" }] };
		const result = await runGate(makePR({ ciStatus: "failure" }), config, audit);
		expect(result.outcome.result).toBe("pass");
	});

	it("rejects duplicate PRs in enforce mode", async () => {
		const config: GateConfig = { criteria: [{ name: "duplicate", mode: "enforce" }] };
		const existing = [makePR({ id: "pr-0" })];
		const result = await runGate(makePR({ id: "pr-1" }), config, audit, existing);
		expect(result.outcome.result).toBe("reject");
	});

	it("does not flag two undeclared-direction PRs as duplicates of each other", async () => {
		const config: GateConfig = { criteria: [{ name: "duplicate", mode: "enforce" }] };
		const existing = [makePR({ id: "pr-0", declaredDirection: UNDECLARED_DIRECTION })];
		const result = await runGate(
			makePR({ id: "pr-1", declaredDirection: UNDECLARED_DIRECTION }),
			config,
			audit,
			existing,
		);
		expect(result.outcome.result).toBe("pass");
	});

	it("does not flag an undeclared-direction PR as out of scope", async () => {
		const config: GateConfig = {
			criteria: [{ name: "outOfScope", mode: "enforce" }],
			scopeKeywords: ["auth"],
		};
		const result = await runGate(makePR({ declaredDirection: UNDECLARED_DIRECTION }), config, audit);
		expect(result.outcome.result).toBe("pass");
	});

	it("records a per-criterion decision only for criteria not in off mode", async () => {
		const config: GateConfig = {
			criteria: [
				{ name: "buildFailure", mode: "enforce" },
				{ name: "outOfScope", mode: "off" },
				{ name: "duplicate", mode: "shadow" },
			],
		};
		const result = await runGate(makePR({ ciStatus: "failure" }), config, audit);
		expect(result.decisions).toHaveLength(2);
		const byName = Object.fromEntries(result.decisions.map((d) => [d.criterionName, d]));
		expect(byName["buildFailure"]).toMatchObject({ mode: "enforce", triggered: true });
		expect(byName["duplicate"]).toMatchObject({ mode: "shadow", triggered: false });
		expect(byName["outOfScope"]).toBeUndefined();
	});
});
