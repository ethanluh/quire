import type { PullRequest } from "../../engine/types/core.js";
import { orchestratePipeline } from "../../engine/pipeline/pipeline.js";
import type { PipelineConfig } from "../../engine/pipeline/pipeline.js";
import type { LlmProvider } from "../../engine/drift/effectList/provider.js";
import { LlmProviderHolder } from "../../engine/drift/effectList/providerHolder.js";
import type { StaticAnalyzer } from "../../engine/drift/footprint/analyzer.js";
import type { AuditStore } from "../../engine/gate/auditStore.js";
import type { InstrumentationSink } from "../../engine/types/instrumentation.js";
import type { ServerState } from "./state.js";

export interface PipelineDeps {
	config: PipelineConfig;
	provider: LlmProvider;
	analyzer: StaticAnalyzer;
	auditStore: AuditStore;
	instrumentationSink?: InstrumentationSink;
}

export interface IngestSummary {
	bundlesCreated: number;
	bundleIds: ReadonlyArray<string>;
	rejected: ReadonlyArray<string>;
	shadowed: ReadonlyArray<string>;
	error?: string;
}

// Shared by POST /prs/ingest and POST /account/github/repos/select — both land PRs on
// the review queue through the same gate → bundle → cheap-screen pipeline and the same
// state mutation, so the response shape and state-population logic exist in one place.
export async function ingestIntoQueue(
	prs: ReadonlyArray<PullRequest>,
	state: ServerState,
	deps: PipelineDeps,
): Promise<IngestSummary> {
	// Pin the provider for the duration of this one ingestion run: deps.provider may be an
	// LlmProviderHolder that can be reassigned mid-run if the user connects/disconnects an
	// LLM account while this run's PRs are still being extracted/clustered. Snapshotting
	// once up front means every comparison within this run uses the same provider/model,
	// instead of silently mixing two providers' embeddings within one clusterPRs batch.
	const provider = deps.provider instanceof LlmProviderHolder ? deps.provider.snapshot() : deps.provider;
	const result = await orchestratePipeline(
		prs,
		deps.config,
		provider,
		deps.analyzer,
		deps.auditStore,
		deps.instrumentationSink,
	);

	for (const bundle of result.bundles) {
		state.bundles.set(bundle.id, bundle);
	}
	for (const card of result.cards) {
		state.cards.set(card.bundleId, card);
	}

	return {
		bundlesCreated: result.bundles.length,
		bundleIds: result.bundles.map((b) => b.id),
		rejected: result.rejected.map((p) => p.id),
		shadowed: result.shadowed.map((p) => p.id),
		...(result.error !== undefined ? { error: result.error } : {}),
	};
}
