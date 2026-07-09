import type { DecidedPrEntry } from "../types/decided.js";
import type { JudgeVerdictRecord } from "../types/judge.js";

// The check on the checker (mission §I): compares each bundle the judge actually scored
// against whatever a human eventually decided for it, joined by bundleId across
// judge-verdicts.json and decided-prs.json — always recomputed from those two logs, never a
// separately persisted metric that could drift out of sync with them.
export interface JudgeAgreementStats {
	// Every verdict the judge produced (status "ok") — includes bundles a human hasn't
	// decided on yet, which is why this can be larger than `comparable`.
	totalJudged: number;
	// Verdicts where a human has since made a real gesture (accept/reject/defer) on the same
	// bundleId — the only rows `agreementRate` is computed from.
	comparable: number;
	agreements: number;
	disagreements: number;
	// undefined (not 0 or NaN) when there is nothing to compare yet — absence of evidence
	// must never be reported as "0% agreement" (INV-3's own discipline, applied here to the
	// judge instead of to a swarm PR).
	agreementRate: number | undefined;
}

export function computeJudgeAgreement(
	verdicts: ReadonlyArray<JudgeVerdictRecord>,
	decided: ReadonlyArray<DecidedPrEntry>,
): JudgeAgreementStats {
	// First decided-PR row per bundleId is enough — every member of a bundle shares the same
	// action/bundleId (see decidedPrStore.ts's markDecided).
	const humanActionByBundle = new Map<string, DecidedPrEntry["action"]>();
	for (const entry of decided) {
		if (!humanActionByBundle.has(entry.bundleId)) humanActionByBundle.set(entry.bundleId, entry.action);
	}

	const judged = verdicts.filter((v) => v.status === "ok" && v.verdict !== undefined);
	let comparable = 0;
	let agreements = 0;
	for (const record of judged) {
		const humanAction = humanActionByBundle.get(record.bundleId);
		if (humanAction === undefined) continue;
		comparable++;
		if (humanAction === record.verdict?.gesture) agreements++;
	}

	return {
		totalJudged: judged.length,
		comparable,
		agreements,
		disagreements: comparable - agreements,
		agreementRate: comparable > 0 ? agreements / comparable : undefined,
	};
}
