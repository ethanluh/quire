import { Router } from "express";
import type { AuditStore } from "../../../engine/gate/auditStore.js";

export function auditRouter(auditStore: AuditStore): Router {
	const router = Router();

	router.get("/", (_req, res) => {
		res.json(auditStore.list());
	});

	// A human's verdict that a shadow-mode flag was wrong — no body, since this is a
	// single judgment call, not a partial update. Feeds the false-positive rate
	// (docs/instrumentation.md, "Gate decisions").
	router.post("/:entryId/overturn", async (req, res, next) => {
		try {
			const entryId = req.params["entryId"] ?? "";
			const found = await auditStore.overturn(entryId);
			if (!found) {
				res.status(404).json({ error: "Audit entry not found" });
				return;
			}
			res.json({ status: "overturned", entryId });
		} catch (err) {
			next(err);
		}
	});

	return router;
}
