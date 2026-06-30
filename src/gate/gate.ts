import type { PullRequest } from "../types/core.js";
import type { GateConfig, GateResult } from "../types/gate.js";
import type { AuditStore } from "./auditStore.js";
import * as buildFailure from "./criteria/buildFailure.js";
import * as testFailure from "./criteria/testFailure.js";
import * as outOfScope from "./criteria/outOfScope.js";
import * as duplicate from "./criteria/duplicate.js";

interface CriterionCheck {
	name: string;
	run(pr: PullRequest, config: GateConfig, existing: ReadonlyArray<PullRequest>): { triggered: boolean; reason: string };
}

const CRITERIA: ReadonlyArray<CriterionCheck> = [
	{
		name: "buildFailure",
		run: (pr) => buildFailure.check(pr),
	},
	{
		name: "testFailure",
		run: (pr) => testFailure.check(pr),
	},
	{
		name: "outOfScope",
		run: (pr, config) => outOfScope.check(pr, config.scopeKeywords ?? []),
	},
	{
		name: "duplicate",
		run: (pr, _config, existing) => duplicate.check(pr, existing),
	},
];

export function runGate(
	pr: PullRequest,
	config: GateConfig,
	auditStore: AuditStore,
	existingPrs: ReadonlyArray<PullRequest> = [],
): GateResult {
	for (const criterion of CRITERIA) {
		const configEntry = config.criteria.find((c) => c.name === criterion.name);
		const mode = configEntry?.mode ?? "off";
		if (mode === "off") continue;

		const { triggered, reason } = criterion.run(pr, config, existingPrs);
		if (!triggered) continue;

		if (mode === "enforce") {
			return { prId: pr.id, outcome: { result: "reject", criterionName: criterion.name, reason } };
		}
		if (mode === "shadow") {
			auditStore.add(pr, criterion.name, reason);
			return { prId: pr.id, outcome: { result: "shadow", criterionName: criterion.name, reason } };
		}
	}
	return { prId: pr.id, outcome: { result: "pass" } };
}
