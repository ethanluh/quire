import { signToken, verifyToken } from "./signedToken.js";

export const SESSION_COOKIE_NAME = "quire_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface SessionPayload {
	login: string;
	issuedAt: number;
	expiresAt: number;
}

function isSessionPayload(value: unknown): value is SessionPayload {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record["login"] === "string" &&
		typeof record["issuedAt"] === "number" &&
		typeof record["expiresAt"] === "number"
	);
}

// Stateless signed token — payload.expiresAt.json base64url'd, then an HMAC signature over
// that string. No session store: revocation isn't needed at this trust level (an allowlist
// removal is checked on every request in requireSession, and disconnecting a GitHub
// installation invalidates API access server-side regardless of any still-valid cookie).
export function signSession(payload: SessionPayload, secret: string): string {
	return signToken(payload, secret);
}

export function verifySession(token: string, secret: string): SessionPayload | undefined {
	return verifyToken(token, secret, isSessionPayload);
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
