import { Router } from "express";
import type { AuditStore } from "../../gate/auditStore.js";
import type { MergeQueue } from "../../queue/mergeQueue.js";
import type { ServerState } from "../state.js";
import { truncateNdjson } from "../../instrumentation/store.js";
import { localOnly } from "../middleware/localOnly.js";

export function adminRouter(
	state: ServerState,
	auditStore: AuditStore,
	queue: MergeQueue,
	deferLogPath: string,
): Router {
	const router = Router();

	router.post("/reset", localOnly, async (_req, res, next) => {
		try {
			state.bundles.clear();
			state.cards.clear();
			state.shelf.clear();
			auditStore.clear();
			await queue.clear();
			await truncateNdjson(deferLogPath);
			res.json({ status: "reset" });
		} catch (err) {
			next(err);
		}
	});

	return router;
}
