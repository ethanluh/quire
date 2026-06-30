import { Router } from "express";
import { z } from "zod";
import type { MergeQueue } from "../../queue/mergeQueue.js";
import type { ServerState } from "../state.js";
import { logDefer } from "../../instrumentation/logger.js";
import { validateBody } from "../middleware/validation.js";

const GestureSchema = z.object({
	action: z.enum(["accept", "defer", "reject"]),
});

export function gesturesRouter(
	state: ServerState,
	queue: MergeQueue,
	deferLogPath: string,
): Router {
	const router = Router({ mergeParams: true });

	router.post(
		"/:bundleId/gesture",
		validateBody(GestureSchema),
		async (req, res, next) => {
			try {
				const bundleId = req.params["bundleId"] ?? "";
				const bundle = state.bundles.get(bundleId);
				const card = state.cards.get(bundleId);

				if (bundle === undefined || card === undefined) {
					res.status(404).json({ error: "Bundle not found" });
					return;
				}

				const { action } = req.body as z.infer<typeof GestureSchema>;

				if (action === "accept") {
					await queue.enqueue(bundle); // enqueues, does not merge (INV-5)
					state.bundles.delete(bundleId);
					state.cards.delete(bundleId);
					res.json({ status: "queued", bundleId });
				} else if (action === "reject") {
					state.bundles.delete(bundleId);
					state.cards.delete(bundleId);
					res.json({ status: "rejected", bundleId });
				} else {
					// defer
					state.shelf.set(bundleId, card);
					state.cards.delete(bundleId);
					await logDefer(deferLogPath, bundleId, card);
					res.json({ status: "deferred", bundleId, shelfPosition: state.shelf.size });
				}
			} catch (err) {
				next(err);
			}
		},
	);

	return router;
}
