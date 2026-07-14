import { Router } from "express";
import type { AuditStore } from "../../../engine/gate/auditStore.js";
import type { MergeQueue } from "../../../engine/queue/mergeQueue.js";
import type { DecidedPrStore } from "../../../engine/queue/decidedPrStore.js";
import type { ServerState } from "../state.js";
import { saveShelf } from "../state.js";
import { truncateNdjson } from "../../../engine/instrumentation/store.js";
import { requireRole } from "../middleware/requireRole.js";
import type { GateConfigStore } from "../../../engine/gate/gateConfigStore.js";
import { resolveEffectiveGateConfig } from "../../../engine/gate/gateConfigStore.js";
import type { GateCriterion, GateMode } from "../../../engine/types/gate.js";
import { GATE_CRITERION_NAMES } from "../../../engine/gate/gate.js";

const KNOWN_CRITERIA_NAMES: ReadonlySet<string> = new Set(GATE_CRITERION_NAMES);
const KNOWN_MODES: ReadonlySet<GateMode> = new Set(["enforce", "shadow", "off"]);

function isValidCriterionBody(value: unknown): value is GateCriterion {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record["name"] === "string" &&
		KNOWN_CRITERIA_NAMES.has(record["name"]) &&
		KNOWN_MODES.has(record["mode"] as GateMode)
	);
}

export interface AdminGateConfigDeps {
	store: GateConfigStore;
	// The platform-wide default this team's override is layered onto (index.ts's
	// pipelineConfig.gate.criteria) — read-only from here, never mutated by this router.
	platformDefault: ReadonlyArray<GateCriterion>;
	// Called after every successful save so the tenant's live PipelineDeps picks up the new
	// effective config immediately (see tenant.ts) instead of waiting for a restart.
	onChange: () => void;
}

export function adminRouter(
	state: ServerState,
	auditStore: AuditStore,
	queue: MergeQueue,
	ndjsonLogPaths: ReadonlyArray<string>,
	decidedStore: DecidedPrStore,
	shelfPath: string,
	gateConfig: AdminGateConfigDeps,
): Router {
	const router = Router();

	// Gated to owner/admin, same as the other tuning-affecting routes here — this changes
	// what gets auto-rejected/shadowed for every PR ingested from now on.
	router.get("/gate-config", requireRole("owner", "admin"), (_req, res) => {
		const override = gateConfig.store.get();
		res.json({
			effective: resolveEffectiveGateConfig(gateConfig.platformDefault, override),
			override: override?.criteria ?? null,
		});
	});

	router.patch("/gate-config", requireRole("owner", "admin"), async (req, res, next) => {
		try {
			const criteria: unknown = (req.body as { criteria?: unknown } | undefined)?.criteria;
			if (!Array.isArray(criteria) || !criteria.every(isValidCriterionBody)) {
				res.status(400).json({
					error: `Body must be { criteria: [{ name, mode }] } with name one of ${[...KNOWN_CRITERIA_NAMES].join(", ")} and mode one of ${[...KNOWN_MODES].join(", ")}`,
				});
				return;
			}
			await gateConfig.store.set({ criteria });
			gateConfig.onChange();
			res.json({ status: "saved", effective: resolveEffectiveGateConfig(gateConfig.platformDefault, gateConfig.store.get()) });
		} catch (err) {
			next(err);
		}
	});

	// Access control (requireSession) is applied once, ahead of every data route, in
	// index.ts — not per-route here. See middleware/requireSession.ts for why a real
	// session cookie replaces the old localOnly+requireAdminHeader pair. requireRole is
	// added on top here since this wipes the shared merge queue along with everything else.
	router.post("/reset", requireRole("owner"), async (_req, res, next) => {
		try {
			state.bundles.clear();
			state.cards.clear();
			state.shelf.clear();
			await saveShelf(state.shelf, shelfPath);
			await auditStore.clear();
			await queue.clear();
			await decidedStore.clearAll();
			await Promise.all(ndjsonLogPaths.map((path) => truncateNdjson(path)));
			res.json({ status: "reset" });
		} catch (err) {
			next(err);
		}
	});

	return router;
}
