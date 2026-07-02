import { createHmac, timingSafeEqual } from "node:crypto";

// Shared by every short-lived, stateless token this server issues (session cookies,
// invite links): sign a JSON payload, verify by recomputing the HMAC in constant time.
// No token-type namespacing in the wire format — callers validate the parsed shape
// themselves via `isValid`, so a session token and an invite token can never be silently
// accepted as each other, since their shapes don't match.
function hmac(value: string, secret: string): string {
	return createHmac("sha256", secret).update(value).digest("base64url");
}

export function signToken(payload: unknown, secret: string): string {
	const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
	return `${body}.${hmac(body, secret)}`;
}

interface Expiring {
	expiresAt: number;
}

// Never throws — bad signature, malformed payload, and expiry are all just "invalid
// token," giving callers one branch to handle instead of a try/catch around parsing.
export function verifyToken<T extends Expiring>(token: string, secret: string, isValid: (value: unknown) => value is T): T | undefined {
	const [body, signature] = token.split(".");
	if (body === undefined || signature === undefined) return undefined;

	const expected = hmac(body, secret);
	const expectedBuf = Buffer.from(expected, "base64url");
	const actualBuf = Buffer.from(signature, "base64url");
	if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) return undefined;

	try {
		const parsed: unknown = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
		if (!isValid(parsed)) return undefined;
		if (Date.now() >= parsed.expiresAt) return undefined;
		return parsed;
	} catch {
		return undefined;
	}
}
