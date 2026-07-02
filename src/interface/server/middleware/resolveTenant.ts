import type { Request, Response, NextFunction } from "express";
import type { TenantContext, TenantRegistry } from "../tenant.js";

declare global {
	// eslint-disable-next-line @typescript-eslint/no-namespace
	namespace Express {
		interface Locals {
			// Set once per request, right after requireSession verifies `login` — every route
			// mounted behind this reads its dependencies (accountState, queue, ...) from here
			// instead of a process-wide singleton, so one signed-in login can never see or
			// mutate another's GitHub connection, repo selection, or PR queue.
			tenant?: TenantContext;
		}
	}
}

// Mounted immediately after requireSession (see index.ts) — by the time this runs,
// res.locals.login is always set, since requireSession already 401'd otherwise.
export function resolveTenant(registry: TenantRegistry) {
	return function (req: Request, res: Response, next: NextFunction): void {
		const login = res.locals.login;
		if (login === undefined) {
			res.status(401).json({ error: "Sign in required" });
			return;
		}
		registry
			.getOrCreate(login)
			.then((tenant) => {
				res.locals.tenant = tenant;
				next();
			})
			.catch(next);
	};
}
