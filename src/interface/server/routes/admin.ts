import { Router } from "express";
import type { AuditStore } from "../../../engine/gate/auditStore.js";
import type { MergeQueue } from "../../../engine/queue/mergeQueue.js";
import type { ServerState } from "../state.js";
import { truncateNdjson } from "../../../engine/instrumentation/store.js";
import { localOnly } from "../middleware/localOnly.js";
import { requireAdminHeader } from "../middleware/requireAdminHeader.js";

export function adminRouter(
	state: ServerState,
	auditStore: AuditStore,
	queue: MergeQueue,
	deferLogPath: string,
): Router {
	const router = Router();

	router.post("/reset", localOnly, requireAdminHeader, async (_req, res, next) => {
		try {
			state.bundles.clear();
			state.cards.clear();
			state.shelf.clear();
			await auditStore.clear();
			await queue.clear();
			await truncateNdjson(deferLogPath);
			res.json({ status: "reset" });
		} catch (err) {
			next(err);
		}
	});

	return router;
}
