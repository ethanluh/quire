import type { Request, Response, NextFunction } from "express";
import type { Allowlist } from "../allowlist.js";

// Layered strictly on top of requireSession (res.locals.login is already verified by the
// time this runs) — never a substitute for it, and mounted only on the platform-admin
// router (see index.ts), which is the one surface in the app that reads across every
// team's TenantContext at once. A team's own owner/admin role (requireRole) grants nothing
// here; this is a wholly separate, higher-privilege allowlist (QUIRE_PLATFORM_ADMIN_LOGINS).
export function requirePlatformAdmin(allowlist: Allowlist) {
	return function (req: Request, res: Response, next: NextFunction): void {
		const login = res.locals.login;
		if (login === undefined) {
			res.status(401).json({ error: "Sign in required" });
			return;
		}
		if (!allowlist.isAllowed(login)) {
			res.status(403).json({ error: "You don't have access to the platform admin console" });
			return;
		}
		next();
	};
}
