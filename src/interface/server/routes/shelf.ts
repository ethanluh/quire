import { Router } from "express";
import type { DecidedPrStore } from "../../../engine/queue/decidedPrStore.js";
import type { ServerState } from "../state.js";
import { saveShelf } from "../state.js";

export function shelfRouter(state: ServerState, decidedStore: DecidedPrStore, shelfPath: string): Router {
	const router = Router();

	router.get("/", (_req, res) => {
		res.json([...state.shelf.values()].map((shelved) => shelved.card));
	});

	router.delete("/:bundleId", async (req, res, next) => {
		try {
			const bundleId = req.params["bundleId"] ?? "";
			const shelved = state.shelf.get(bundleId);
			if (shelved === undefined) {
				res.status(404).json({ error: "Bundle not found on shelf" });
				return;
			}
			state.shelf.delete(bundleId);
			await saveShelf(state.shelf, shelfPath);
			// Promote back to review queue. A human explicitly asking to reconsider a
			// deferred bundle is a "this deserves fresh review" signal, same as a webhook's
			// synchronize event — so its members' decided-PR record is cleared too, or a
			// webhook/reconciliation refresh would immediately treat them as still-decided
			// and exclude them again.
			state.cards.set(bundleId, shelved.card);
			// Restore the full bundle too, in case a repo refresh swept state.bundles while
			// this bundle sat on the shelf (clearRepoFromQueue doesn't know about the shelf).
			if (shelved.bundle !== undefined) {
				state.bundles.set(bundleId, shelved.bundle);
			}
			for (const prId of shelved.memberPrIds) {
				await decidedStore.clearDecided(prId);
			}
			res.json({ status: "promoted", bundleId });
		} catch (err) {
			next(err);
		}
	});

	return router;
}
