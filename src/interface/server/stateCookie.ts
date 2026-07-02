import { randomBytes } from "node:crypto";
import { parse } from "cookie";
import type { CookieOptions, Request, Response } from "express";

// Shared by every cookie this server sets (session, and the two CSRF-state nonces below) —
// one place to get httpOnly/sameSite/secure/path right, after a prior bug where maxAge was
// passed in seconds instead of the milliseconds res.cookie expects.
export function cookieOptions(secure: boolean, maxAgeMs: number): CookieOptions {
	return {
		httpOnly: true,
		sameSite: "lax",
		secure,
		path: "/",
		maxAge: maxAgeMs,
	};
}

// Mints a nonce and stores it in a short-lived cookie scoped to the browser doing the flow
// (not a server-wide variable — see consumeStateCookie's comment for why that matters).
//
// Reuses an existing pending nonce from this same request's cookie instead of always
// minting fresh: a double-click or a second tab from the SAME browser calling /start again
// should get back the value already embedded in the first tab's rendered authorize/install
// URL, not a new one that would silently orphan it once the first tab's callback arrives.
// Minting unconditionally is what a per-browser cookie needs to avoid the cross-user
// clobbering a server-wide singleton had — but unconditional minting is a stronger, unasked-
// for property than that fix requires, and it costs same-browser multi-tab tolerance the
// old singleton design had on purpose.
export function mintOrReuseStateCookie(req: Request, res: Response, name: string, ttlMs: number, secure: boolean): string {
	const existing = parse(req.headers.cookie ?? "")[name];
	const state = existing ?? randomBytes(32).toString("hex");
	res.cookie(name, state, cookieOptions(secure, ttlMs));
	return state;
}

// Reads and clears the pending-state cookie for a callback to compare against the query
// param GitHub (or the App's Setup URL) redirected back with.
export function consumeStateCookie(req: Request, res: Response, name: string): string | undefined {
	const pending = parse(req.headers.cookie ?? "")[name];
	res.clearCookie(name, { path: "/" });
	return pending;
}
