import { Router } from "express";
import type { ServerState } from "../state.js";

export function bundlesRouter(state: ServerState): Router {
	const router = Router();

	router.get("/", (_req, res) => {
		const cards = [...state.cards.values()].map((card) => {
			const bundle = state.bundles.get(card.bundleId);
			return { ...card, assignedTo: bundle?.assignedTo, assignedAt: bundle?.assignedAt, assignedBy: bundle?.assignedBy };
		});
		res.json(cards);
	});

	router.get("/:id", (req, res) => {
		const id = req.params["id"] ?? "";
		const shelved = state.shelf.get(id);
		const card = state.cards.get(id) ?? shelved?.card;
		if (card === undefined) {
			res.status(404).json({ error: "Bundle not found" });
			return;
		}
		const bundle = state.bundles.get(id) ?? shelved?.bundle;
		res.json({
			...card,
			effectSummary: bundle?.effectSummary ?? "",
			members: bundle?.members ?? [],
			assignedTo: bundle?.assignedTo,
			assignedAt: bundle?.assignedAt,
			assignedBy: bundle?.assignedBy,
		});
	});

	return router;
}
