import { Router } from "express";
import type { ServerState } from "../state.js";

export function bundlesRouter(state: ServerState): Router {
	const router = Router();

	router.get("/", (_req, res) => {
		const cards = [...state.cards.values()];
		res.json(cards);
	});

	router.get("/:id", (req, res) => {
		const card = state.cards.get(req.params["id"] ?? "");
		if (card === undefined) {
			res.status(404).json({ error: "Bundle not found" });
			return;
		}
		res.json(card);
	});

	return router;
}
