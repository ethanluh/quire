import { Router } from "express";
import type { ServerState } from "../state.js";
import type { Bundle } from "../../../engine/types/core.js";
import { orderByConflictRisk } from "../../../engine/bundle/conflictOrder.js";

export function bundlesRouter(state: ServerState): Router {
	const router = Router();

	router.get("/", (_req, res) => {
		const cards = [...state.cards.values()].map((card) => {
			const bundle = state.bundles.get(card.bundleId);
			return { ...card, assignedTo: bundle?.assignedTo, assignedAt: bundle?.assignedAt, assignedBy: bundle?.assignedBy };
		});

		// Ordered so a human working top-to-bottom minimizes downstream rebases: bundles that
		// don't share files with anything else surface first, bundles entangled with many
		// others sink toward the bottom. Recomputed on every request (not cached) since the
		// pending set shifts as bundles are accepted/rejected/deferred, and the computation is
		// cheap relative to however many bundles are currently in the queue.
		const bundles = [...state.cards.keys()]
			.map((bundleId) => state.bundles.get(bundleId))
			.filter((bundle): bundle is Bundle => bundle !== undefined);
		const order = orderByConflictRisk(bundles);
		const orderIndex = new Map(order.map((id, index) => [id, index]));
		cards.sort((a, b) => (orderIndex.get(a.bundleId) ?? Number.MAX_SAFE_INTEGER) - (orderIndex.get(b.bundleId) ?? Number.MAX_SAFE_INTEGER));

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
