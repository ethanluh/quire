import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE_NAME = "quire_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface SessionPayload {
	login: string;
	issuedAt: number;
	expiresAt: number;
}

function sign(value: string, secret: string): string {
	return createHmac("sha256", secret).update(value).digest("base64url");
}

// Stateless signed token — payload.expiresAt.json base64url'd, then an HMAC signature over
// that string. No session store: revocation isn't needed at this trust level (an allowlist
// removal is checked on every request in requireSession, and disconnecting a GitHub
// installation invalidates API access server-side regardless of any still-valid cookie).
export function signSession(payload: SessionPayload, secret: string): string {
	const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
	return `${body}.${sign(body, secret)}`;
}

// Never throws — bad signature, malformed payload, and expiry are all just "no session",
// giving requireSession one branch to handle instead of a try/catch around parsing.
export function verifySession(token: string, secret: string): SessionPayload | undefined {
	const [body, signature] = token.split(".");
	if (body === undefined || signature === undefined) return undefined;

	const expected = sign(body, secret);
	const expectedBuf = Buffer.from(expected, "base64url");
	const actualBuf = Buffer.from(signature, "base64url");
	if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) return undefined;

	try {
		const parsed: unknown = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			typeof (parsed as Record<string, unknown>)["login"] !== "string" ||
			typeof (parsed as Record<string, unknown>)["issuedAt"] !== "number" ||
			typeof (parsed as Record<string, unknown>)["expiresAt"] !== "number"
		) {
			return undefined;
		}
		const payload = parsed as SessionPayload;
		if (Date.now() >= payload.expiresAt) return undefined;
		return payload;
	} catch {
		return undefined;
	}
}

export function createSession(login: string, secret: string): string {
	const now = Date.now();
	return signSession({ login, issuedAt: now, expiresAt: now + SESSION_TTL_MS }, secret);
}

// Sliding expiration: an active user re-signs a fresh token (same login, same issuedAt is
// NOT preserved — a renewal is a new grant) on every request that passes verification, so
// they're never booted mid-session as long as they keep using the app within the TTL.
export function renewSession(login: string, secret: string): string {
	return createSession(login, secret);
}
