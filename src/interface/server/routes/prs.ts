import { Router } from "express";
import type { MergeQueue } from "../../../engine/queue/mergeQueue.js";
import type { ServerState } from "../state.js";
import { validateIncomingPayload, normalizePR } from "../../../engine/ingest/ingest.js";
import { ingestIntoQueue } from "../ingestIntoQueue.js";
import type { PipelineDeps } from "../ingestIntoQueue.js";
import { requireRole } from "../middleware/requireRole.js";

export function prsRouter(state: ServerState, deps: PipelineDeps, _queue: MergeQueue): Router {
	const router = Router();

	// Owner/admin only: this injects arbitrary caller-supplied PR payloads straight into the
	// team's review queue, producing bundles/cards. Real swarm PRs arrive through GitHub
	// (refreshRepoQueue / the webhook), so this manual seed path shouldn't be open to every
	// member.
	router.post("/ingest", requireRole("owner", "admin"), async (req, res, next) => {
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
