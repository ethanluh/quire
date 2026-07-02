import { Router } from "express";
import type { AuditStore } from "../../../engine/gate/auditStore.js";
import type { MergeQueue } from "../../../engine/queue/mergeQueue.js";
import type { DecidedPrStore } from "../../../engine/queue/decidedPrStore.js";
import type { ServerState } from "../state.js";
import { truncateNdjson } from "../../../engine/instrumentation/store.js";
import { requireRole } from "../middleware/requireRole.js";

export function adminRouter(
	state: ServerState,
	auditStore: AuditStore,
	queue: MergeQueue,
	ndjsonLogPaths: ReadonlyArray<string>,
	decidedStore: DecidedPrStore,
): Router {
	const router = Router();

	// Access control (requireSession) is applied once, ahead of every data route, in
	// index.ts — not per-route here. See middleware/requireSession.ts for why a real
	// session cookie replaces the old localOnly+requireAdminHeader pair. requireRole is
	// added on top here since this wipes the shared merge queue along with everything else.
	router.post("/reset", requireRole("owner"), async (_req, res, next) => {
		try {
			state.bundles.clear();
			state.cards.clear();
			state.shelf.clear();
			await auditStore.clear();
			await queue.clear();
			await decidedStore.clearAll();
			await Promise.all(ndjsonLogPaths.map((path) => truncateNdjson(path)));
			res.json({ status: "reset" });
		} catch (err) {
			next(err);
		}
	});

	return router;
}
