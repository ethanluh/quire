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
				// entry.status reflects the real outcome — "landed" or, since a member PR
				// couldn't be made mergeable, "conflict" (with entry.conflict disclosing why).
				res.json({ status: entry.status, bundleId: entry.bundleId, ...(entry.conflict !== undefined ? { conflict: entry.conflict } : {}) });
			}
		} catch (err) {
			next(err);
		}
	});

	// A bundle stuck in "conflict" (automated resolution didn't apply or couldn't confidently
	// resolve it — see INV-6) goes back to "queued" so the next /process pass tries again,
	// whether the human fixed it manually on GitHub or just wants another attempt.
	router.post("/:bundleId/retry", async (req, res, next) => {
		try {
			const bundleId = req.params["bundleId"] ?? "";
			const retried = await queue.retryConflict(bundleId);
			if (retried === undefined) {
				res.status(400).json({ error: `Bundle ${bundleId} is not in a conflict state` });
				return;
			}
			res.json({ status: "queued", bundleId });
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
