import type { Bundle, ReviewCard } from "../types/core.js";
import type { DecidedPrEntry } from "../types/decided.js";
import type { QueueState } from "../types/queue.js";
import type { ShelfState } from "../types/shelf.js";
import type { JudgeConstitution, JudgeMode, JudgeThresholds } from "../types/judge.js";
import type { LlmProvider } from "../drift/effectList/provider.js";
import type { InstrumentationSink } from "../types/instrumentation.js";
import type { SlackNotifier } from "../../interface/notify/slack.js";
import { matchRiskTaxonomy } from "./riskTaxonomy.js";
import { retrievePrecedent } from "./precedent.js";
import { runBundleJudge } from "./bundleJudge.js";
import { applyConstitutionGate } from "./gate.js";
import type { JudgeVerdictStore } from "./judgeVerdictStore.js";
import { attemptAutoAction } from "./actionPipeline.js";
import type { ActionPipelineDeps } from "./actionPipeline.js";
import { errorMessage } from "../util/error.js";

export interface JudgeRunDeps {
	mode: JudgeMode;
	constitution: JudgeConstitution;
	// Pre-resolved (env overrides already applied via gate.ts's resolveJudgeThresholds) by
	// the caller — this module doesn't read process.env itself, matching how every other
	// engine-layer module in this codebase stays free of direct env access.
	thresholds: JudgeThresholds;
	provider: LlmProvider;
	getQueueState: () => QueueState;
	getShelfState: () => ShelfState;
	getDecidedEntries: () => ReadonlyArray<DecidedPrEntry>;
	verdictStore: JudgeVerdictStore;
	sink?: InstrumentationSink;
	// Always present (a NoopSlackNotifier when unconfigured) regardless of mode — shadow
	// mode's own "predict + log + Slack (optional)" leg needs it independent of actionDeps,
	// which only exists for "auto" mode.
	slack: SlackNotifier;
	// Present only in "assist" mode — the ServerState.cards map ingestIntoQueue.ts already
	// populated, so the judge's recommendation can be attached to the exact card the review
	// queue already serves, without a second round trip.
	cardsMap?: Map<string, ReviewCard>;
	// Fraction (0..1) of gate-allowed "auto" mode verdicts to hold back and route to the
	// human queue instead of auto-acting — "the check on the checker" (mission §I). undefined
	// or 0 samples nothing.
	auditSampleRate?: number;
	// Present only when this tenant's judge is fully wired for autonomous action (action
	// store, GitHub write access). Only ever acted on when mode === "auto" AND the gate
	// allowed the verdict AND this bundle wasn't sampled for audit — shadow/assist modes
	// compute and log the same gate decision without ever reaching attemptAutoAction,
	// regardless of whether this is set.
	actionDeps?: ActionPipelineDeps;
}

// Instrumentation is an add-on, never a hard dependency — a sink call that throws must not
// take down bundle judging. Mirrors pipeline.ts's own logSafely exactly.
async function logSafely(call: (() => Promise<void> | void) | undefined): Promise<void> {
	if (call === undefined) return;
	try {
		await call();
	} catch (err) {
		console.error("judge instrumentation sink error (ignored):", err);
	}
}

// The single entry point ingestIntoQueue.ts calls for each newly-computed card (see
// docs/judge-integration-map.md §1). Never throws — a judge failure of any kind (a thrown
// error from the LLM call, a gate misconfiguration) is caught and logged, and ingestion
// proceeds exactly as if the judge did not exist. Idempotent by (bundleId, card.inputsHash):
// re-ingesting an unchanged bundle (a webhook retrigger, the reconcile poll) never re-judges
// or re-logs it.
export async function runJudgeForBundle(bundle: Bundle, card: ReviewCard, deps: JudgeRunDeps): Promise<void> {
	if (deps.mode === "off") return;

	// Never judge a bundle that failed drift-detection (constraint 4 — "dishonest direction
	// => no autonomous action, period"). The caller is expected to already filter to eligible
	// bundles before calling this at all; this check is defense in depth, not the primary
	// gate, so a future caller that forgets to filter fails closed instead of silently judging
	// a flagged bundle.
	if (card.drift.status !== "clean" || card.specConformance.status !== "clean") return;

	if (deps.verdictStore.find(bundle.id, card.inputsHash) !== undefined) return;

	try {
		const deterministicRiskFlags = matchRiskTaxonomy(bundle, deps.constitution.riskTaxonomy);
		const precedent = retrievePrecedent(bundle, deps.getQueueState(), deps.getShelfState(), deps.getDecidedEntries());
		const result = await runBundleJudge(
			{ bundle, card, constitution: deps.constitution, precedent, deterministicRiskFlags },
			deps.provider,
		);

		const computedAt = new Date().toISOString();
		if (result.status === "abstained") {
			await deps.verdictStore.save({
				bundleId: bundle.id,
				inputsHash: card.inputsHash,
				mode: deps.mode,
				computedAt,
				status: "abstained",
				abstainReason: result.reason,
			});
			await logSafely(() => deps.sink?.logJudgeVerdict?.({ bundleId: bundle.id, status: "abstained", mode: deps.mode, recordedAt: computedAt }));
			return;
		}

		const gate = applyConstitutionGate(result.verdict, card.blastRadius, deps.thresholds, deps.constitution);
		await deps.verdictStore.save({
			bundleId: bundle.id,
			inputsHash: card.inputsHash,
			mode: deps.mode,
			computedAt,
			status: "ok",
			verdict: result.verdict,
			gate,
		});
		await logSafely(() =>
			deps.sink?.logJudgeVerdict?.({
				bundleId: bundle.id,
				status: "ok",
				mode: deps.mode,
				gesture: result.verdict.gesture,
				confidence: result.verdict.confidence,
				gateAllowed: gate.allowed,
				recordedAt: computedAt,
			}),
		);

		// Only "auto" mode ever acts. "shadow" and "assist" compute and log the identical gate
		// decision above (that's the calibration signal) but never reach attemptAutoAction —
		// each has its own, non-acting way of surfacing that decision instead.
		if (deps.mode === "shadow") {
			// The judge's own "predict + log + Slack (optional)" leg — a prediction of what
			// auto mode would have done, never something that actually happened.
			await logSafely(() =>
				deps.slack.notifyShadowPrediction({
					bundleId: bundle.id,
					directionSummary: bundle.direction,
					wouldGesture: result.verdict.gesture,
					wouldAutoAct: gate.allowed,
					rationale: result.verdict.rationale,
				}),
			);
		} else if (deps.mode === "assist") {
			// Surfaces the recommendation on the card a human is about to see — never a
			// substitute for their own gesture (INV-1). Replaces the map entry (not a mutation
			// in place) to match this codebase's immutable-update convention elsewhere.
			deps.cardsMap?.set(bundle.id, {
				...card,
				judgeRecommendation: {
					gesture: result.verdict.gesture,
					confidence: result.verdict.confidence,
					rationale: result.verdict.rationale,
					wouldAutoAct: gate.allowed,
				},
			});
		} else if (deps.mode === "auto") {
			if (!gate.allowed) {
				// The bundle itself is left exactly where it already is (still in the review
				// queue — nothing above removed it), which is the correct "escalate to a
				// human" behavior on its own; the Slack notification is what turns that into
				// an actual signal a human sees, per the mission's GATE step.
				await logSafely(() =>
					deps.slack.notifyEscalation({
						bundleId: bundle.id,
						directionSummary: bundle.direction,
						reason: gate.reasons.join("; "),
						rationale: result.verdict.rationale,
						links: [],
					}),
				);
			} else if (deps.auditSampleRate !== undefined && deps.auditSampleRate > 0 && Math.random() < deps.auditSampleRate) {
				// The check on the checker (mission §I): even a gate-allowed verdict is
				// sometimes routed to a human instead of auto-acted on, purely so judge-vs-
				// human agreement can be measured on a live sample, not just on whatever a
				// human happens to review after the fact.
				await logSafely(() =>
					deps.slack.notifyEscalation({
						bundleId: bundle.id,
						directionSummary: bundle.direction,
						reason: `sampled for human audit (QUIRE_JUDGE_AUDIT_SAMPLE_RATE=${deps.auditSampleRate}) rather than auto-acted, despite the gate allowing it`,
						rationale: result.verdict.rationale,
						links: [],
					}),
				);
			} else if (deps.actionDeps !== undefined) {
				await attemptAutoAction(bundle, card, result.verdict, deps.actionDeps);
			}
		}
	} catch (err) {
		// The judge is an add-on, never a hard dependency of ingestion — same "never let this
		// break the hot path" discipline pipeline.ts's own instrumentation handling applies.
		console.error(`Bundle judge failed for bundle ${bundle.id} (ingestion continues regardless):`, errorMessage(err));
	}
}
