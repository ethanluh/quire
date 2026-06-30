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

	// Gate each PR
	for (const pr of prs) {
		const result = runGate(pr, config.gate, auditStore, passed);
		if (result.outcome.result === "pass") {
			passed.push(pr);
		} else if (result.outcome.result === "reject") {
			rejected.push(pr);
		} else {
			shadowed.push(pr);
		}
	}

	// Bundle surviving PRs
	const bundles = await buildBundles(passed, provider, config.bundle);

	// Cheap drift screen for every member
	const cards: ReviewCard[] = [];
	for (const bundle of bundles) {
		const driftVerdicts = new Map<string, DriftVerdict>();
		for (const member of bundle.members) {
			const verdict = await runCheapScreen(member, bundle, provider, analyzer);
			driftVerdicts.set(member.id, verdict);
		}
		cards.push(buildReviewCard(bundle, driftVerdicts));
	}

	return { cards, bundles, rejected, shadowed };
}
