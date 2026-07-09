import type { Bundle, ReviewCard } from "../types/core.js";
import type { DecidedPrEntry } from "../types/decided.js";
import type { QueueState } from "../types/queue.js";
import type { ShelfState } from "../types/shelf.js";
import type { JudgeConstitution, JudgeMode, JudgeThresholds } from "../types/judge.js";
import type { LlmProvider } from "../drift/effectList/provider.js";
import type { InstrumentationSink } from "../types/instrumentation.js";
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
	// Present only when this tenant's judge is fully wired for autonomous action (Slack,
	// action store, GitHub write access). Only ever acted on when mode === "auto" AND the
	// gate allowed the verdict — shadow/assist modes compute and log the same gate decision
	// without ever reaching attemptAutoAction, regardless of whether this is set.
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

		// Only "auto" mode ever acts — "shadow" and "assist" log the identical gate decision
		// above (that's the calibration signal) but stop there, exactly as if the judge did
		// not exist beyond logging.
		if (deps.mode === "auto" && deps.actionDeps !== undefined) {
			if (gate.allowed) {
				await attemptAutoAction(bundle, card, result.verdict, deps.actionDeps);
			} else {
				// The bundle itself is left exactly where it already is (still in the review
				// queue — nothing above removed it), which is the correct "escalate to a
				// human" behavior on its own; the Slack notification is what turns that into
				// an actual signal a human sees, per the mission's GATE step.
				await logSafely(() =>
					deps.actionDeps?.slack.notifyEscalation({
						bundleId: bundle.id,
						directionSummary: bundle.direction,
						reason: gate.reasons.join("; "),
						rationale: result.verdict.rationale,
						links: [],
					}),
				);
			}
		}
	} catch (err) {
		// The judge is an add-on, never a hard dependency of ingestion — same "never let this
		// break the hot path" discipline pipeline.ts's own instrumentation handling applies.
		console.error(`Bundle judge failed for bundle ${bundle.id} (ingestion continues regardless):`, errorMessage(err));
	}
}
