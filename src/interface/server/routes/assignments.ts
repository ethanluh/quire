import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import type { Bundle } from "../../../engine/types/core.js";
import type { ServerState } from "../state.js";
import { validateBody } from "../middleware/validation.js";

const AssignSchema = z.object({ login: z.string().min(1) });

// Separate from gesturesRouter (both mounted at "/bundles" in tenant.ts, same pattern as
// bundlesRouter/gesturesRouter already splitting reads from the gesture-and-gate flow) so
// explicit hand-routing stays a distinct concern from the self-assign-on-gesture path.
export function assignmentsRouter(state: ServerState): Router {
	const router = Router({ mergeParams: true });

	// Shared preamble for both assign routes: resolve the bundle, the actor, and whether the
	// actor may act on a bundle currently assigned to someone else. Writes the 404/401/403
	// response itself and returns undefined in that case, so callers just early-return; a
	// non-undefined return is the narrowed context both handlers need.
	function resolveAssignmentContext(
		req: Request,
		res: Response,
	): { bundle: Bundle; actorLogin: string; isPrivileged: boolean } | undefined {
		const bundleId = req.params["bundleId"] ?? "";
		const bundle = state.bundles.get(bundleId);
		if (bundle === undefined) {
			res.status(404).json({ error: "Bundle not found" });
			return undefined;
		}
		const actorLogin = res.locals.login;
		const membership = res.locals.membership;
		if (actorLogin === undefined || membership === undefined) {
			res.status(401).json({ error: "Sign in required" });
			return undefined;
		}
		const isPrivileged = membership.role === "owner" || membership.role === "admin";
		if (bundle.assignedTo !== undefined && bundle.assignedTo !== actorLogin && !isPrivileged) {
			res.status(403).json({ error: "This bundle is assigned to another team member", assignedTo: bundle.assignedTo });
			return undefined;
		}
		return { bundle, actorLogin, isPrivileged };
	}

	router.post("/:bundleId/assign", validateBody(AssignSchema), (req, res) => {
		const ctx = resolveAssignmentContext(req, res);
		if (ctx === undefined) return;
		const { bundle, actorLogin, isPrivileged } = ctx;
		const { login: targetLogin } = req.body as z.infer<typeof AssignSchema>;

		if (targetLogin !== actorLogin && !isPrivileged) {
			res.status(403).json({ error: "Only owners/admins can assign a bundle to someone else" });
			return;
		}

		const updated: Bundle = {
			...bundle,
			assignedTo: targetLogin,
			assignedAt: new Date().toISOString(),
			assignedBy: actorLogin,
		};
		state.bundles.set(bundle.id, updated);
		res.json({ assignedTo: updated.assignedTo, assignedAt: updated.assignedAt, assignedBy: updated.assignedBy });
	});

	router.delete("/:bundleId/assign", (req, res) => {
		const ctx = resolveAssignmentContext(req, res);
		if (ctx === undefined) return;
		const { bundle } = ctx;

		const { assignedTo: _assignedTo, assignedAt: _assignedAt, assignedBy: _assignedBy, ...rest } = bundle;
		state.bundles.set(bundle.id, rest);
		res.json({ unassigned: true });
	});

	return router;
}
