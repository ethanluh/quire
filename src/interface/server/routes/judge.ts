import { Router } from "express";
import type { JudgeVerdictStore } from "../../../engine/judge/judgeVerdictStore.js";
import type { JudgeActionStore } from "../../../engine/judge/judgeActionStore.js";
import type { DecidedPrStore } from "../../../engine/queue/decidedPrStore.js";
import { computeJudgeAgreement } from "../../../engine/judge/agreement.js";

export interface JudgeRouterDeps {
	// Both undefined whenever this tenant's judge never loaded (mode "off", or the
	// constitution failed to load) — every route below degrades to an empty/zeroed response
	// rather than a 404, same "unconfigured degrades cleanly" contract as everywhere else.
	verdictStore?: JudgeVerdictStore;
	actionStore?: JudgeActionStore;
	decidedStore: DecidedPrStore;
}

// Read-only, open to every team member (mirrors auditRouter.ts's own openness) — this is
// visibility into an already-running subsystem, not a control surface. Phase 4's action
// pipeline is the only thing that mutates judge state; nothing here does.
export function judgeRouter(deps: JudgeRouterDeps): Router {
	const router = Router();

	router.get("/verdicts", (_req, res) => {
		res.json(deps.verdictStore?.list() ?? []);
	});

	router.get("/actions", (_req, res) => {
		res.json(deps.actionStore?.list() ?? []);
	});

	// The judge-vs-human agreement metric (mission §I) — always recomputed live from the two
	// underlying logs, never a separately persisted number that could go stale.
	router.get("/agreement", (_req, res) => {
		res.json(computeJudgeAgreement(deps.verdictStore?.list() ?? [], deps.decidedStore.list()));
	});

	return router;
}
