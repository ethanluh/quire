import { Router } from "express";
import type { MergeQueue } from "../../../engine/queue/mergeQueue.js";
import type { ServerState } from "../state.js";
import { validateIncomingPayload, normalizePR } from "../../../engine/ingest/ingest.js";
import { ingestIntoQueue } from "../ingestIntoQueue.js";
import type { PipelineDeps } from "../ingestIntoQueue.js";

export function prsRouter(state: ServerState, deps: PipelineDeps, _queue: MergeQueue): Router {
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

			const summary = await ingestIntoQueue(prs, state, deps);
			res.json(summary);
		} catch (err) {
			next(err);
		}
	});

	return router;
}
