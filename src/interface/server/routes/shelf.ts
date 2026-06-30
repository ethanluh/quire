import { Router } from "express";
import type { ServerState } from "../state.js";

export function shelfRouter(state: ServerState): Router {
	const router = Router();

	router.get("/", (_req, res) => {
		res.json([...state.shelf.values()]);
	});

	router.delete("/:bundleId", (req, res) => {
		const bundleId = req.params["bundleId"] ?? "";
		const card = state.shelf.get(bundleId);
		if (card === undefined) {
			res.status(404).json({ error: "Bundle not found on shelf" });
			return;
		}
		state.shelf.delete(bundleId);
		// Promote back to review queue
		state.cards.set(bundleId, card);
		res.json({ status: "promoted", bundleId });
	});

	return router;
}
