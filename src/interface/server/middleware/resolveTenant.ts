import type { Request, Response, NextFunction } from "express";
import type { TenantContext, TenantRegistry } from "../tenant.js";

declare global {
	// eslint-disable-next-line @typescript-eslint/no-namespace
	namespace Express {
		interface Locals {
			// Set once per request, after resolveMembership resolves the caller's active team —
			// every route mounted behind this reads its dependencies (accountState, queue, ...)
			// from here instead of a process-wide singleton, so a login can never see or mutate
			// another team's GitHub connection, repo selection, or PR queue.
			tenant?: TenantContext;
		}
	}
}

// Mounted immediately after resolveMembership (see index.ts) — by the time this runs,
// res.locals.membership is always set, since resolveMembership already 401'd or
// auto-provisioned a team otherwise.
export function resolveTenant(registry: TenantRegistry) {
	return async function (req: Request, res: Response, next: NextFunction): Promise<void> {
		const teamId = res.locals.membership?.teamId;
		if (teamId === undefined) {
			res.status(401).json({ error: "Sign in required" });
			return;
		}
		try {
			res.locals.tenant = await registry.getOrCreate(teamId);
			next();
		} catch (err) {
			next(err);
		}
	};
}
