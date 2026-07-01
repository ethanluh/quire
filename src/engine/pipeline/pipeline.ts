import type { Bundle, DriftVerdict, PullRequest, ReviewCard } from "../types/core.js";
import type { GateConfig } from "../types/gate.js";
import type { InstrumentationSink } from "../types/instrumentation.js";
import type { LlmProvider } from "../drift/effectList/provider.js";
import type { StaticAnalyzer } from "../drift/footprint/analyzer.js";
import type { AuditStore } from "../gate/auditStore.js";
import { runGate } from "../gate/gate.js";
import { buildBundles, type BundleConfig } from "../bundle/bundler.js";
import { runCheapScreen } from "../drift/screen.js";
import { buildReviewCard } from "../review/card.js";

export interface PipelineConfig {
	gate: GateConfig;
	bundle: BundleConfig;
}

export interface PipelineResult {
	cards: ReadonlyArray<ReviewCard>;
	bundles: ReadonlyArray<Bundle>;
	rejected: ReadonlyArray<PullRequest>;
	shadowed: ReadonlyArray<PullRequest>;
	// Set when bundling or screening fails partway through. Gate results (passed/
	// rejected/shadowed, including audit-store writes already made) are still valid and
	// returned above; cards/bundles only cover what completed before the failure, so a
	// caller can decide whether to retry, surface a partial review queue, or both.
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
	provider: LlmProvider,
	analyzer: StaticAnalyzer,
	auditStore: AuditStore,
	// Optional: instrumentation is a pluggable add-on, not a hard dependency for the
	// pipeline to run. Omitting it (or the caller's sink lacking a method) is a no-op.
	sink?: InstrumentationSink,
): Promise<PipelineResult> {
	const passed: PullRequest[] = [];
	const rejected: PullRequest[] = [];
	const shadowed: PullRequest[] = [];

	// Gate each PR
	for (const pr of prs) {
		const result = runGate(pr, config.gate, auditStore, passed);
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
	}

	// Bundling and screening can fail partway through (provider/analyzer errors). Gate
	// results above already reflect committed audit-store writes, so on failure we still
	// return them — along with whatever cards did complete — instead of throwing and
	// losing work the caller has no way to recover.
	const bundles: Bundle[] = [];
	const cards: ReviewCard[] = [];
	try {
		bundles.push(...(await buildBundles(passed, provider, config.bundle)));

		for (const bundle of bundles) {
			const driftVerdicts = new Map<string, DriftVerdict>();
			for (const member of bundle.members) {
				const verdict = await runCheapScreen(member, bundle, provider, analyzer);
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
		const error = err instanceof Error ? err.message : String(err);
		return { cards, bundles, rejected, shadowed, error };
	}

	return { cards, bundles, rejected, shadowed };
}
