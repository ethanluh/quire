import type { Request, Response, NextFunction } from "express";

// A bare cross-origin `fetch(url, { method: "POST" })` carries no body and no custom
// headers, so it's a CORS "simple request" the browser sends without a preflight —
// `localOnly`'s remote-address check can't see the difference between that and a click
// on Quire's own button, since both originate from 127.0.0.1. Requiring an arbitrary
// custom header forces the browser to preflight first; since this server never answers
// with Access-Control-Allow-Origin, the preflight fails and the real request never goes
// out from a cross-origin page. Same-origin pages (i.e. Quire's own UI) are unaffected.
export const ADMIN_HEADER = "x-quire-admin";

export function requireAdminHeader(req: Request, res: Response, next: NextFunction): void {
	if (req.get(ADMIN_HEADER) === undefined) {
		res.status(403).json({ error: `Missing required ${ADMIN_HEADER} header` });
		return;
	}
	next();
}
