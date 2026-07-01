import { Router } from "express";
import type { LlmProvider } from "../../../engine/drift/effectList/provider.js";
import type { StaticAnalyzer } from "../../../engine/drift/footprint/analyzer.js";
import type { AuditStore } from "../../../engine/gate/auditStore.js";
import type { MergeQueue } from "../../../engine/queue/mergeQueue.js";
import type { InstrumentationSink } from "../../../engine/types/instrumentation.js";
import type { ServerState } from "../state.js";
import { validateIncomingPayload, normalizePR } from "../../../engine/ingest/ingest.js";
import { orchestratePipeline } from "../../../engine/pipeline/pipeline.js";
import type { PipelineConfig } from "../../../engine/pipeline/pipeline.js";

export function prsRouter(
	state: ServerState,
	pipelineConfig: PipelineConfig,
	provider: LlmProvider,
	analyzer: StaticAnalyzer,
	auditStore: AuditStore,
	_queue: MergeQueue,
	instrumentationSink?: InstrumentationSink,
): Router {
	const router = Router();

	router.post("/ingest", async (req, res, next) => {
		try {
			const payloads: unknown[] = Array.isArray(req.body) ? req.body : [req.body];
			const prs = [];
			for (const payload of payloads) {
				const validated = validateIncomingPayload(payload);
				if (!validated.success) {
					res.status(400).json({ error: validated.error });
					return;
				}
				prs.push(normalizePR(validated.data));
			}

			const result = await orchestratePipeline(
				prs,
				pipelineConfig,
				provider,
				analyzer,
				auditStore,
				instrumentationSink,
			);

			for (const bundle of result.bundles) {
				state.bundles.set(bundle.id, bundle);
			}
			for (const card of result.cards) {
				state.cards.set(card.bundleId, card);
			}

			res.json({
				bundlesCreated: result.bundles.length,
				rejected: result.rejected.map((p) => p.id),
				shadowed: result.shadowed.map((p) => p.id),
				bundleIds: result.bundles.map((b) => b.id),
			});
		} catch (err) {
			next(err);
		}
	});

	return router;
}
