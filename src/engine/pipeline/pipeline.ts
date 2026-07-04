import type { Bundle, DriftVerdict, PullRequest, ReviewCard } from "../types/core.js";
import type { GateConfig } from "../types/gate.js";
import type { InstrumentationSink } from "../types/instrumentation.js";
import type { LlmProvider } from "../drift/effectList/provider.js";
import type { StaticAnalyzer } from "../drift/footprint/analyzer.js";
import type { AuditStore } from "../gate/auditStore.js";
import { runGate } from "../gate/gate.js";
import { buildBundles, type BundleConfig } from "../bundle/bundler.js";
import { errorMessage } from "../util/error.js";
import { runCheapScreen } from "../drift/screen.js";
import { buildReviewCard, computeInputsHash, reuseReviewCard } from "../review/card.js";
import { PrEffectCache } from "../cache/prCache.js";

export interface PipelineConfig {
	gate: GateConfig;
	bundle: BundleConfig;
}

export interface PipelineRunDeps {
	provider: LlmProvider;
	analyzer: StaticAnalyzer;
	auditStore: AuditStore;
	// Ephemeral by default: with no cache passed in, every PR is always a cache miss,
	// reproducing today's "always extract, always cluster fresh" behavior exactly.
	prCache?: PrEffectCache;
	// Optional: instrumentation is a pluggable add-on, not a hard dependency for the
	// pipeline to run. Omitting it (or the caller's sink lacking a method) is a no-op.
	sink?: InstrumentationSink;
}

// The previous call's bundles/cards for this same PR set, used to seed clustering and
// skip re-screening bundles that didn't change. Empty by default, which reproduces
// today's full-batch clustering and full re-screening exactly.
export interface PriorPipelineRun {
	bundles: ReadonlyArray<Bundle>;
	cards: ReadonlyMap<string, ReviewCard>;
}

const EMPTY_PRIOR_RUN: PriorPipelineRun = { bundles: [], cards: new Map() };

export interface PipelineResult {
	cards: ReadonlyArray<ReviewCard>;
	bundles: ReadonlyArray<Bundle>;
	rejected: ReadonlyArray<PullRequest>;
	shadowed: ReadonlyArray<PullRequest>;
	// Set when gating, bundling, or screening fails partway through. Whatever gate
	// outcomes (passed/rejected/shadowed, including audit-store writes already made)
	// and cards/bundles completed before the failure are still valid and returned
	// above, so a caller can decide whether to retry, surface a partial review queue,
	// or both — instead of throwing and losing the work already done.
	error?: string;
}

// Instrumentation is documented as an add-on, never a hard dependency: a sink
// call that throws (disk full, permission error, ...) must not abort the
// pipeline or discard results the caller has no way to recover.
async function logSafely(call: (() => Promise<void> | void) | undefined): Promise<void> {
	if (call === undefined) return;
	try {
		await call();
	} catch (err) {
		console.error("instrumentation sink error (ignored):", err);
	}
}

export async function orchestratePipeline(
	prs: ReadonlyArray<PullRequest>,
	config: PipelineConfig,
	deps: PipelineRunDeps,
	priorRun: PriorPipelineRun = EMPTY_PRIOR_RUN,
): Promise<PipelineResult> {
	const { provider, analyzer, auditStore, sink } = deps;
	const prCache = deps.prCache ?? new PrEffectCache();
	const passed: PullRequest[] = [];
	const rejected: PullRequest[] = [];
	const shadowed: PullRequest[] = [];

	// Gate each PR. A gate can fail partway through (e.g. the audit-store write for a
	// shadow-mode hit hits a disk error) — stop gating further PRs but still return
	// what was already decided, rather than losing it to an uncaught rejection.
	for (const pr of prs) {
		try {
			const result = await runGate(pr, config.gate, auditStore, passed);
			for (const decision of result.decisions) {
				await logSafely(() => sink?.logGateDecision?.(decision));
			}
			if (result.outcome.result === "pass") {
				passed.push(pr);
			} else if (result.outcome.result === "reject") {
				rejected.push(pr);
			} else {
				shadowed.push(pr);
			}
		} catch (err) {
			const error = errorMessage(err);
			return { cards: [], bundles: [], rejected, shadowed, error };
		}
	}

	// Bundling and screening can fail partway through (provider/analyzer errors). Gate
	// results above already reflect committed audit-store writes, so on failure we still
	// return them — along with whatever cards did complete — instead of throwing and
	// losing work the caller has no way to recover.
	const bundles: Bundle[] = [];
	const cards: ReviewCard[] = [];
	let extractionError: string | undefined;
	try {
		const { bundles: builtBundles, effectsByPr, extractionFailures, clusteringFailures } = await buildBundles(
			passed, provider, config.bundle, prCache, priorRun.bundles,
		);
		bundles.push(...builtBundles);

		const failureNotices: string[] = [];
		if (extractionFailures.length > 0) {
			failureNotices.push(`effect extraction failed for ${extractionFailures.length} PR(s): ${extractionFailures
				.map((f) => `${f.pr.id} (${f.error})`)
				.join("; ")}`);
		}
		if (clusteringFailures.length > 0) {
			failureNotices.push(`clustering failed for ${clusteringFailures.length} PR(s): ${clusteringFailures
				.map((f) => `${f.pr.id} (${f.error})`)
				.join("; ")}`);
		}
		if (failureNotices.length > 0) {
			extractionError = failureNotices.join("; ");
		}

		for (const bundle of bundles) {
			// computeInputsHash proves whether blastRadius/flags/drift would come out
			// identical to the prior run without recomputing them — a strictly stronger
			// check than "membership + reextraction" (it also catches same-members-same-
			// headShas-but-different-effectSummary, and stays correct if the drift screen
			// ever grows a new input this hash doesn't yet cover... though it would need
			// updating then too). directionSummary is excluded on purpose (see
			// reuseReviewCard) so a declaredDirection-only edit is never served stale.
			const priorCard = priorRun.cards.get(bundle.id);
			const canReuse = priorCard !== undefined && priorCard.inputsHash === computeInputsHash(bundle);
			if (canReuse) {
				cards.push(reuseReviewCard(bundle, priorCard));
				continue;
			}

			const driftVerdicts = new Map<string, DriftVerdict>();
			for (const member of bundle.members) {
				const rawClauses = effectsByPr.get(member.id) ?? [];
				const verdict = await runCheapScreen(member, bundle, rawClauses, provider, analyzer);
				driftVerdicts.set(member.id, verdict);
				await logSafely(() =>
					sink?.logDriftScreen?.({
						bundleId: bundle.id,
						prId: member.id,
						signalCount: verdict.status === "flagged" ? verdict.signals.length : 0,
						flagged: verdict.status === "flagged",
						recordedAt: new Date().toISOString(),
					}),
				);
			}
			cards.push(buildReviewCard(bundle, driftVerdicts));
		}
	} catch (err) {
		const error = errorMessage(err);
		return { cards, bundles, rejected, shadowed, error };
	}

	return { cards, bundles, rejected, shadowed, ...(extractionError ? { error: extractionError } : {}) };
}
