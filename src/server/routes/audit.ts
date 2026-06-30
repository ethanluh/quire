import { Router } from "express";
import type { AuditStore } from "../../gate/auditStore.js";

export function auditRouter(auditStore: AuditStore): Router {
	const router = Router();

	router.get("/", (_req, res) => {
		res.json(auditStore.list());
	});

	return router;
}
