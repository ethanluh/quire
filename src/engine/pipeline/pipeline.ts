import type { Bundle, DriftVerdict, PullRequest, ReviewCard } from "../types/core.js";
import type { GateConfig } from "../types/gate.js";
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
	// Set when gating, bundling, or screening fails partway through. Whatever gate
	// outcomes (passed/rejected/shadowed, including audit-store writes already made)
	// and cards/bundles completed before the failure are still valid and returned
	// above, so a caller can decide whether to retry, surface a partial review queue,
	// or both — instead of throwing and losing the work already done.
	error?: string;
}

export async function orchestratePipeline(
	prs: ReadonlyArray<PullRequest>,
	config: PipelineConfig,
	provider: LlmProvider,
	analyzer: StaticAnalyzer,
	auditStore: AuditStore,
): Promise<PipelineResult> {
	const passed: PullRequest[] = [];
	const rejected: PullRequest[] = [];
	const shadowed: PullRequest[] = [];

	// Gate each PR. A gate can fail partway through (e.g. the audit-store write for a
	// shadow-mode hit hits a disk error) — stop gating further PRs but still return
	// what was already decided, rather than losing it to an uncaught rejection.
	for (const pr of prs) {
		try {
			const result = await runGate(pr, config.gate, auditStore, passed);
			if (result.outcome.result === "pass") {
				passed.push(pr);
			} else if (result.outcome.result === "reject") {
				rejected.push(pr);
			} else {
				shadowed.push(pr);
			}
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			return { cards: [], bundles: [], rejected, shadowed, error };
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
			}
			cards.push(buildReviewCard(bundle, driftVerdicts));
		}
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		return { cards, bundles, rejected, shadowed, error };
	}

	return { cards, bundles, rejected, shadowed };
}
