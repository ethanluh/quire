import type { Request, Response, NextFunction } from "express";
import type { TeamRole } from "../../../engine/types/team.js";
import type { TeamStore } from "../../../engine/team/teamStore.js";

declare global {
	// eslint-disable-next-line @typescript-eslint/no-namespace
	namespace Express {
		interface Locals {
			// Set once per request, right after requireSession verifies `login` and before
			// resolveTenant resolves the team-scoped TenantContext — every route mounted behind
			// this reads the caller's team and role from here.
			membership?: { teamId: string; role: TeamRole };
		}
	}
}

// Mounted immediately after requireSession, before resolveTenant (see index.ts) — by the
// time this runs, res.locals.login is always set, since requireSession already 401'd
// otherwise. Every signed-in login has an active team by the time this returns: a login
// with no membership index yet (first request ever) gets a personal team-of-one
// auto-provisioned here, so nothing downstream ever has to special-case "no team" — see
// TeamStore.resolveActiveMembership, which also repairs an index that's fallen out of
// sync with the team roster instead of throwing.
export function resolveMembership(teamStore: TeamStore) {
	return async function (req: Request, res: Response, next: NextFunction): Promise<void> {
		const login = res.locals.login;
		if (login === undefined) {
			res.status(401).json({ error: "Sign in required" });
			return;
		}

		try {
			const membership = await teamStore.resolveActiveMembership(login);
			res.locals.membership = { teamId: membership.teamId, role: membership.role };
			next();
		} catch (err) {
			next(err);
		}
	};
}
