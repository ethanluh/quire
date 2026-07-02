import { Router } from "express";
import type { MergeQueue } from "../../../engine/queue/mergeQueue.js";
import type { DecidedPrStore } from "../../../engine/queue/decidedPrStore.js";
import type { ServerState } from "../state.js";

export function queueRouter(queue: MergeQueue, state: ServerState, decidedStore: DecidedPrStore): Router {
	const router = Router();

	router.get("/", async (_req, res, next) => {
		try {
			res.json(await queue.listEntries());
		} catch (err) {
			next(err);
		}
	});

	router.post("/process", async (_req, res, next) => {
		try {
			const entry = await queue.dequeueNext();
			if (entry === undefined) {
				res.json({ status: "empty" });
			} else {
				res.json({ status: "landed", bundleId: entry.bundleId });
			}
		} catch (err) {
			next(err);
		}
	});

	router.delete("/:bundleId/prs/:prId", async (req, res, next) => {
		try {
			const bundleId = req.params["bundleId"] ?? "";
			const prId = req.params["prId"] ?? "";
			const url = await queue.revertPr(bundleId, prId);
			res.json({ status: "reverted", revertUrl: url });
		} catch (err) {
			next(err);
		}
	});

	router.delete("/:bundleId", async (req, res, next) => {
		try {
			const bundleId = req.params["bundleId"] ?? "";
			const removed = await queue.removeQueued(bundleId);
			if (removed === undefined) {
				res.json({ status: "removed" }); // not found, or already past "queued" — same no-op as today
				return;
			}
			if (removed.card !== undefined) {
				// Restore to the review queue (INV-5: an accept must stay reversible until the
				// queue lands it), with the exact card the human already saw.
				state.cards.set(bundleId, removed.card);
				state.bundles.set(bundleId, removed.bundle);
				for (const pr of removed.bundle.members) {
					await decidedStore.clearDecided(pr.id);
				}
				res.json({ status: "restored", bundleId });
				return;
			}
			// Legacy entry with no stored card — nothing to restore into the review queue.
			res.json({ status: "removed", bundleId });
		} catch (err) {
			next(err);
		}
	});

	return router;
}
