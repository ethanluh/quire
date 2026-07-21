import type { PullRequest } from "../../engine/types/core.js";
import { orchestratePipeline } from "../../engine/pipeline/pipeline.js";
import type { PipelineConfig, PriorPipelineRun } from "../../engine/pipeline/pipeline.js";
import type { LlmProvider } from "../../engine/drift/effectList/provider.js";
import { LlmProviderHolder } from "../../engine/drift/effectList/providerHolder.js";
import type { StaticAnalyzer } from "../../engine/drift/footprint/analyzer.js";
import type { PatternRegistryClient } from "../../engine/drift/patternRegistry/client.js";
import type { AuditStore } from "../../engine/gate/auditStore.js";
import type { InstrumentationSink } from "../../engine/types/instrumentation.js";
import type { PrEffectCache } from "../../engine/cache/prCache.js";
import type { ServerState } from "./state.js";

export interface PipelineDeps {
	config: PipelineConfig;
	provider: LlmProvider;
	analyzer: StaticAnalyzer;
	auditStore: AuditStore;
	prCache: PrEffectCache;
	instrumentationSink?: InstrumentationSink;
	patternRegistry?: PatternRegistryClient;
}

export interface IngestSummary {
	bundlesCreated: number;
	bundleIds: ReadonlyArray<string>;
	rejected: ReadonlyArray<string>;
	shadowed: ReadonlyArray<string>;
	error?: string;
}

// Thrown (internally — see refreshRepoQueue's enqueueRefresh) when the caller's isSuperseded
// check, re-evaluated immediately before committing to `state`, reports that a newer refresh
// for the same repo already took over. orchestratePipeline's LLM-backed extraction below can
// run long enough on its own for that to happen even when nothing upstream of this call
// stalled — the commit must stay gated on a check taken right up against the write, not one
// taken before this (possibly slow) call started.
export class StaleIngestError extends Error {}

// Shared by POST /prs/ingest and POST /account/github/repos/select — both land PRs on
// the review queue through the same gate → bundle → cheap-screen pipeline and the same
// state mutation, so the response shape and state-population logic exist in one place.
//
// `priorRun` — the previous call's bundles/cards for this repo, captured by the caller
// before any of its own state mutation (e.g. refreshRepoQueue's clearRepoFromQueue) wipes
// them — lets the pipeline skip re-clustering/re-screening anything unchanged. Omitted by
// /prs/ingest (manual ingestion always clusters fresh, matching its pre-existing behavior).
export async function ingestIntoQueue(
	prs: ReadonlyArray<PullRequest>,
	state: ServerState,
	deps: PipelineDeps,
	priorRun?: PriorPipelineRun,
	isSuperseded?: () => boolean,
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
		{
			provider,
			analyzer: deps.analyzer,
			auditStore: deps.auditStore,
			prCache: deps.prCache,
			...(deps.instrumentationSink !== undefined ? { sink: deps.instrumentationSink } : {}),
			...(deps.patternRegistry !== undefined ? { patternRegistry: deps.patternRegistry } : {}),
		},
		priorRun,
	);

	// No await between this check and the commit loops below — synchronous end to end, so
	// nothing else can run (and thus supersede this call) in between.
	if (isSuperseded?.() === true) {
		throw new StaleIngestError("Ingestion superseded by a newer refresh; discarding stale result");
	}
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
