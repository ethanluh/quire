import { Router } from "express";
import type { MergeQueue } from "../../../engine/queue/mergeQueue.js";

export function queueRouter(queue: MergeQueue): Router {
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
			await queue.removeQueued(req.params["bundleId"] ?? "");
			res.json({ status: "removed" });
		} catch (err) {
			next(err);
		}
	});

	return router;
}
