import type { Request, Response, NextFunction } from "express";
import type { TeamRole } from "../../../engine/types/team.js";

// Applied inline per-route (like validateBody), not globally — most routes stay open to
// every team member; only merge-queue mutations and team-composition changes need this.
// Mirrors requireSession.ts's factory/res.locals/JSON-error style. 401 for "not signed in
// at all" (shouldn't be reachable here since resolveMembership already runs first, but
// checked defensively rather than assumed) vs. 403 for "signed in, wrong role."
export function requireRole(...roles: ReadonlyArray<TeamRole>) {
	return function (req: Request, res: Response, next: NextFunction): void {
		const membership = res.locals.membership;
		if (membership === undefined) {
			res.status(401).json({ error: "Sign in required" });
			return;
		}
		if (!roles.includes(membership.role)) {
			res.status(403).json({ error: "You don't have permission to do this" });
			return;
		}
		next();
	};
}
