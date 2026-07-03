import { parse } from "cookie";
import type { Request, Response, NextFunction } from "express";
import type { Allowlist } from "../allowlist.js";
import { SESSION_COOKIE_NAME, SESSION_TTL_MS, renewSession, verifySession } from "../session.js";
import { cookieOptions } from "../stateCookie.js";

declare global {
	// eslint-disable-next-line @typescript-eslint/no-namespace
	namespace Express {
		interface Locals {
			// The verified session's GitHub login. Later stages add `ctx`/`actorLogin` once a
			// tenant/team concept exists — for now this is the sole per-request identity.
			login?: string;
		}
	}
}

// Replaces localOnly+requireAdminHeader everywhere except the login-establishing routes
// (oauth/start, oauth/callback), the HMAC-verified webhook route, and the conflict-resolution
// Action callback (its own per-dispatch capability token — see routes/actionCallback.ts). A
// real SameSite cookie makes the old custom-header CSRF defense redundant — a cross-origin
// page can't get an authenticated request sent at all, so one middleware now does auth, CSRF
// protection, and (from Stage 2 onward) tenant resolution.
export function requireSession(sessionSecret: string, allowlist: Allowlist, secureCookies: boolean) {
	return function (req: Request, res: Response, next: NextFunction): void {
		const cookies = parse(req.headers.cookie ?? "");
		const token = cookies[SESSION_COOKIE_NAME];
		const payload = token !== undefined ? verifySession(token, sessionSecret) : undefined;

		if (payload === undefined) {
			res.status(401).json({ error: "Sign in required" });
			return;
		}
		if (!allowlist.isAllowed(payload.login)) {
			res.status(401).json({ error: "This GitHub account is no longer authorized to use this Quire instance" });
			return;
		}

		res.locals.login = payload.login;
		res.cookie(SESSION_COOKIE_NAME, renewSession(payload.login, sessionSecret), cookieOptions(secureCookies, SESSION_TTL_MS));
		next();
	};
}
