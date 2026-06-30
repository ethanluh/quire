import type { Request, Response, NextFunction } from "express";

// Checked against the TCP socket's remote address, not a client-supplied header,
// so it can't be spoofed by a request originating off-box.
const LOCAL_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function localOnly(req: Request, res: Response, next: NextFunction): void {
	const remoteAddress = req.socket.remoteAddress ?? "";
	if (!LOCAL_ADDRESSES.has(remoteAddress)) {
		res.status(403).json({ error: "This endpoint is only available from localhost" });
		return;
	}
	next();
}
