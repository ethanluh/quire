import type { PullRequest } from "../types/core.js";
import type { GateConfig, GateCriterionOutcome, GateResult } from "../types/gate.js";
import type { AuditStore } from "./auditStore.js";
import * as buildFailure from "./criteria/buildFailure.js";
import * as outOfScope from "./criteria/outOfScope.js";
import * as duplicate from "./criteria/duplicate.js";

interface CriterionCheck {
	name: string;
	run(pr: PullRequest, config: GateConfig, existing: ReadonlyArray<PullRequest>): { triggered: boolean; reason: string };
}

// "buildFailure" covers the PR's whole CI signal (pr.ciStatus). There used to be a
// separate "testFailure" criterion, but it checked the exact same field, so the two
// could never actually be configured with independent confidence levels — one always
// shadowed the other. Collapsed into a single criterion that matches what the data
// model can actually distinguish; split it back out if/when CI reports build and test
// status separately.
const CRITERIA: ReadonlyArray<CriterionCheck> = [
	{
		name: "buildFailure",
		run: (pr) => buildFailure.check(pr),
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
	let rejection: { criterionName: string; reason: string } | undefined;
	let shadowed: { criterionName: string; reason: string } | undefined;
	const criteriaOutcomes: GateCriterionOutcome[] = [];

	// Evaluate every criterion rather than stopping at the first match, so a PR that
	// trips more than one shadow-mode criterion gets every hit recorded in the audit
	// store — not just whichever criterion happens to be listed first.
	for (const criterion of CRITERIA) {
		const configEntry = config.criteria.find((c) => c.name === criterion.name);
		const mode = configEntry?.mode ?? "off";
		if (mode === "off") continue;

		const { triggered, reason } = criterion.run(pr, config, existingPrs);
		criteriaOutcomes.push({ criterionName: criterion.name, mode, triggered });
		if (!triggered) continue;

		if (mode === "enforce") {
			rejection ??= { criterionName: criterion.name, reason };
		} else if (mode === "shadow") {
			auditStore.add(pr, criterion.name, reason);
			shadowed ??= { criterionName: criterion.name, reason };
		}
	}

	if (rejection !== undefined) {
		return { prId: pr.id, outcome: { result: "reject", ...rejection }, criteriaOutcomes };
	}
	if (shadowed !== undefined) {
		return { prId: pr.id, outcome: { result: "shadow", ...shadowed }, criteriaOutcomes };
	}
	return { prId: pr.id, outcome: { result: "pass" }, criteriaOutcomes };
}
