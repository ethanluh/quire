import { Router } from "express";
import type { MergeQueue } from "../../../engine/queue/mergeQueue.js";
import type { DecidedPrStore } from "../../../engine/queue/decidedPrStore.js";
import type { ServerState } from "../state.js";
import { requireRole } from "../middleware/requireRole.js";

export function queueRouter(queue: MergeQueue, state: ServerState, decidedStore: DecidedPrStore): Router {
	const router = Router();

	router.get("/", async (_req, res, next) => {
		try {
			res.json(await queue.listEntries());
		} catch (err) {
			next(err);
		}
	});

	// Everything below actually mutates the shared merge queue (merges, reverts, requeues,
	// pulls a bundle back to review) — restricted to the team's owner. Everyday triage
	// (the accept/defer/reject gestures, which only enqueue) stays open to every member;
	// see gestures.ts.
	router.post("/process", requireRole("owner"), async (_req, res, next) => {
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
	// resolve it — see INV-6) or "aborted" (a human gave up on it earlier) goes back to
	// "queued" so the next /process pass tries again.
	router.post("/:bundleId/retry", requireRole("owner"), async (req, res, next) => {
		try {
			const bundleId = req.params["bundleId"] ?? "";
			const retried = await queue.reattempt(bundleId);
			if (retried === undefined) {
				res.status(400).json({ error: `Bundle ${bundleId} is not in a conflict or aborted state` });
				return;
			}
			res.json({ status: "queued", bundleId });
		} catch (err) {
			next(err);
		}
	});

	// A bundle stuck mid-landing (possibly with some members already merged) or blocked on
	// conflict — the human is giving up on it rather than continuing to retry. Does not
	// revert mergedPrIds (see MergeQueue.abort); a separate DELETE /:bundleId/prs/:prId call
	// handles that per PR.
	router.post("/:bundleId/abort", requireRole("owner"), async (req, res, next) => {
		try {
			const bundleId = req.params["bundleId"] ?? "";
			const aborted = await queue.abort(bundleId);
			if (aborted === undefined) {
				res.status(400).json({ error: `Bundle ${bundleId} is not in an abortable state` });
				return;
			}
			res.json({ status: "aborted", bundleId });
		} catch (err) {
			next(err);
		}
	});

	router.delete("/:bundleId/prs/:prId", requireRole("owner"), async (req, res, next) => {
		try {
			const bundleId = req.params["bundleId"] ?? "";
			const prId = req.params["prId"] ?? "";
			const url = await queue.revertPr(bundleId, prId);
			res.json({ status: "reverted", revertUrl: url });
		} catch (err) {
			next(err);
		}
	});

	router.delete("/:bundleId", requireRole("owner"), async (req, res, next) => {
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
