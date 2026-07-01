import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

const SIGNATURE_HEADER = "x-hub-signature-256";

function isValidSignature(secret: string, body: Buffer, signatureHeader: string): boolean {
	const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
	const expectedBuf = Buffer.from(expected, "utf8");
	const actualBuf = Buffer.from(signatureHeader, "utf8");
	// timingSafeEqual throws on a length mismatch rather than returning false, so a
	// legitimately-different-length header (or an empty one) must be guarded first.
	if (expectedBuf.length !== actualBuf.length) return false;
	return timingSafeEqual(expectedBuf, actualBuf);
}

// GitHub's webhook delivery is a genuine external server-to-server request, not a request
// from the machine owner's own browser — so unlike every other route in this router family,
// the trust boundary here is an HMAC signature over a shared secret, not source IP
// (localOnly). Requires the route be mounted with a raw (unparsed) body — see index.ts.
export function verifyGithubSignature(secret: string) {
	return (req: Request, res: Response, next: NextFunction): void => {
		const signature = req.get(SIGNATURE_HEADER);
		const body = req.body;
		if (signature === undefined || !Buffer.isBuffer(body) || !isValidSignature(secret, body, signature)) {
			res.status(401).json({ error: "Invalid webhook signature" });
			return;
		}
		next();
	};
}
