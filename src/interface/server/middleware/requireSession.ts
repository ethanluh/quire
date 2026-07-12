import { parse } from "cookie";
import type { Request, Response, NextFunction } from "express";
import type { Allowlist } from "../allowlist.js";
import { SESSION_ABSOLUTE_MAX_MS, SESSION_COOKIE_NAME, SESSION_TTL_MS, renewSession, verifySession } from "../session.js";
import { cookieOptions } from "../stateCookie.js";
import type { SessionEpochStore } from "../sessionEpoch.js";

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
// (oauth/start, oauth/callback) and the HMAC-verified webhook route. A real SameSite cookie
// makes the old custom-header CSRF defense redundant — a cross-origin page can't get an
// authenticated request sent at all, so one middleware now does auth, CSRF protection, and
// (from Stage 2 onward) tenant resolution.
export function requireSession(sessionSecret: string, allowlist: Allowlist, secureCookies: boolean, sessionEpochs: SessionEpochStore) {
	return async function (req: Request, res: Response, next: NextFunction): Promise<void> {
		try {
			const cookies = parse(req.headers.cookie ?? "");
			const token = cookies[SESSION_COOKIE_NAME];
			const payload = token !== undefined ? verifySession(token, sessionSecret) : undefined;

			if (payload === undefined) {
				res.status(401).json({ error: "Sign in required" });
				return;
			}
			// Absolute lifetime, measured from the original grant — sliding renewal can't extend a
			// session past this, so a leaked cookie can't be kept alive forever by re-use.
			if (Date.now() - payload.issuedAt >= SESSION_ABSOLUTE_MAX_MS) {
				res.status(401).json({ error: "Session expired — sign in again" });
				return;
			}
			// Logout (and any future forced-revocation) bumps a per-login epoch; a token minted
			// before it is dead even though its signature still verifies — this is what makes
			// stateless-cookie logout actually end the session (see sessionEpoch.ts).
			if (payload.issuedAt < (await sessionEpochs.invalidatedBefore(payload.login))) {
				res.status(401).json({ error: "Session ended — sign in again" });
				return;
			}
			if (!allowlist.isAllowed(payload.login)) {
				res.status(401).json({ error: "This GitHub account is no longer authorized to use this Quire instance" });
				return;
			}

			res.locals.login = payload.login;
			res.cookie(SESSION_COOKIE_NAME, renewSession(payload, sessionSecret), cookieOptions(secureCookies, SESSION_TTL_MS));
			next();
		} catch (err) {
			next(err);
		}
	};
}
