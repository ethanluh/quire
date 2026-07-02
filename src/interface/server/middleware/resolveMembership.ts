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
// auto-provisioned here, so nothing downstream ever has to special-case "no team".
export function resolveMembership(teamStore: TeamStore) {
	return function (req: Request, res: Response, next: NextFunction): void {
		const login = res.locals.login;
		if (login === undefined) {
			res.status(401).json({ error: "Sign in required" });
			return;
		}

		(async () => {
			let index = await teamStore.loadMembershipIndex(login);
			if (index === undefined) {
				await teamStore.createTeamForLogin(login, `${login}'s team`);
				index = await teamStore.loadMembershipIndex(login);
			}
			if (index === undefined) {
				throw new Error(`Failed to provision a team for ${login}`);
			}

			const membership = await teamStore.getMembership(index.activeTeamId, login);
			if (membership === undefined) {
				throw new Error(`Login ${login}'s membership index points at a team it isn't a member of`);
			}

			res.locals.membership = { teamId: index.activeTeamId, role: membership.role };
			next();
		})().catch(next);
	};
}
