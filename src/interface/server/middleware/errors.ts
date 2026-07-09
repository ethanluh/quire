import { randomUUID } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

// Unhandled errors funnel here from every route's `next(err)`. Their raw `.message` routinely
// embeds infrastructure detail — absolute data-dir paths, tenant ids, upstream GitHub/LLM API
// internals, occasionally credential fragments — so returning it verbatim to the caller is an
// information-disclosure leak. Log the full error server-side against a correlation id, and
// return only that id plus a generic message. Routes that need to surface a specific,
// client-safe message already do so with their own res.status().json() and never reach here.
export function errorHandler(
	err: unknown,
	_req: Request,
	res: Response,
	_next: NextFunction,
): void {
	const errorId = randomUUID();
	console.error(`Unhandled request error [${errorId}]:`, err);
	if (res.headersSent) return;
	res.status(500).json({ error: "Internal server error", errorId });
}
