import type { JudgeConstitution, JudgeGateOutcome, JudgeThresholds, JudgeVerdict, RubricScoreBand } from "../types/judge.js";

export interface JudgeThresholdEnv {
	QUIRE_JUDGE_AUTOACCEPT_CONFIDENCE?: string;
	QUIRE_JUDGE_AUTOREJECT_CONFIDENCE?: string;
	QUIRE_JUDGE_MAX_BLAST_RADIUS_AUTO?: string;
}

function parseNumberEnv(value: string | undefined): number | undefined {
	if (value === undefined || value === "") return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

// An explicit env var wins over the constitution document's own defaults — the same
// "explicit config beats a baked-in default" precedence an account connected through the UI
// already takes over resolveLlmProvider's env-based defaults. Throws (never silently
// misconfigures) if the override would break the ordering constitution.ts itself enforces at
// load time — a caller (tenant.ts) is expected to catch this the same way it catches a
// malformed constitution file, degrading the judge rather than crashing tenant startup.
export function resolveJudgeThresholds(env: JudgeThresholdEnv, constitution: JudgeConstitution): JudgeThresholds {
	const autoAcceptConfidence = parseNumberEnv(env.QUIRE_JUDGE_AUTOACCEPT_CONFIDENCE) ?? constitution.thresholds.autoAcceptConfidence;
	const autoRejectConfidence = parseNumberEnv(env.QUIRE_JUDGE_AUTOREJECT_CONFIDENCE) ?? constitution.thresholds.autoRejectConfidence;
	const maxBlastRadiusAuto = parseNumberEnv(env.QUIRE_JUDGE_MAX_BLAST_RADIUS_AUTO) ?? constitution.thresholds.maxBlastRadiusAuto;

	if (autoRejectConfidence <= autoAcceptConfidence) {
		throw new Error(
			`Judge thresholds: autoRejectConfidence (${autoRejectConfidence}) must be greater than autoAcceptConfidence ` +
				`(${autoAcceptConfidence}) — check QUIRE_JUDGE_AUTOACCEPT_CONFIDENCE/QUIRE_JUDGE_AUTOREJECT_CONFIDENCE`,
		);
	}
	return { autoAcceptConfidence, autoRejectConfidence, maxBlastRadiusAuto };
}

// "The lowest band" per docs/judge-constitution.md's reversibility criterion — the band
// with the smallest minScore, regardless of how many bands the document defines for it.
function isInLowestBand(bands: ReadonlyArray<RubricScoreBand>, score: number): boolean {
	const lowest = bands.reduce<RubricScoreBand | undefined>((acc, b) => (acc === undefined || b.minScore < acc.minScore ? b : acc), undefined);
	return lowest !== undefined && score < lowest.maxScore;
}

// Applies docs/judge-constitution.md's auto-act rule: confidence over the action's threshold,
// AND blast radius under the cap, AND reversibility not in its lowest band, AND zero
// risk-taxonomy matches (verdict.riskFlags already merges the deterministic and model-
// reported halves — see bundleJudge.ts). Any single failure falls through to escalate; there
// is no partial credit. Pure and JudgeMode-agnostic on purpose: shadow mode calls this too,
// to log what auto mode *would* have decided, without ever acting on it — see
// docs/judge-integration-map.md §1 and the orchestrator in orchestrate.ts.
export function applyConstitutionGate(
	verdict: JudgeVerdict,
	blastRadius: number,
	thresholds: JudgeThresholds,
	constitution: JudgeConstitution,
): JudgeGateOutcome {
	if (verdict.gesture === "defer") {
		return { allowed: false, reasons: ["defer is never auto-acted on — it is already the cheap, reversible, human-scrutiny gesture"] };
	}

	const reasons: string[] = [];

	const confidenceThreshold = verdict.gesture === "accept" ? thresholds.autoAcceptConfidence : thresholds.autoRejectConfidence;
	if (verdict.confidence < confidenceThreshold) {
		reasons.push(`confidence ${verdict.confidence.toFixed(2)} is below the ${verdict.gesture} threshold ${confidenceThreshold.toFixed(2)}`);
	}

	if (blastRadius > thresholds.maxBlastRadiusAuto) {
		reasons.push(`blast radius ${blastRadius} exceeds the auto-act cap ${thresholds.maxBlastRadiusAuto}`);
	}

	const reversibilityCriterion = constitution.rubric.find((c) => c.key === "reversibility");
	if (reversibilityCriterion !== undefined && isInLowestBand(reversibilityCriterion.bands, verdict.criteria.reversibility)) {
		reasons.push(`reversibility score ${verdict.criteria.reversibility.toFixed(2)} falls in its lowest band — not cleanly reversible`);
	}

	if (verdict.riskFlags.length > 0) {
		reasons.push(`risk taxonomy match: ${verdict.riskFlags.join(", ")}`);
	}

	if (reasons.length > 0) return { allowed: false, reasons };
	return { allowed: true, gesture: verdict.gesture };
}
