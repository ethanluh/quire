import { createHmac, timingSafeEqual } from "node:crypto";

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface InvitePayload {
	teamId: string;
	invitedBy: string; // login, informational/audit only
	issuedAt: number;
	expiresAt: number;
}

// Same base64url-JSON + HMAC-SHA256 shape as session.ts's signSession/verifySession, and
// the same secret — an invite is "a capability granted by whoever holds the server's
// session secret," the same trust root everything else here already uses. Deliberately
// not stateCookie.ts's nonce+cookie pattern: that nonce means nothing outside the cookie
// that stores it, scoped to the browser that started the flow — wrong for a link that
// must be opened by a different person in a different browser with no prior cookie.
function sign(value: string, secret: string): string {
	return createHmac("sha256", secret).update(value).digest("base64url");
}

export function signInvite(payload: InvitePayload, secret: string): string {
	const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
	return `${body}.${sign(body, secret)}`;
}

// Never throws — bad signature, malformed payload, and expiry are all just "invalid
// invite," giving callers one branch to handle instead of a try/catch around parsing.
export function verifyInvite(token: string, secret: string): InvitePayload | undefined {
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
			typeof (parsed as Record<string, unknown>)["teamId"] !== "string" ||
			typeof (parsed as Record<string, unknown>)["invitedBy"] !== "string" ||
			typeof (parsed as Record<string, unknown>)["issuedAt"] !== "number" ||
			typeof (parsed as Record<string, unknown>)["expiresAt"] !== "number"
		) {
			return undefined;
		}
		const payload = parsed as InvitePayload;
		if (Date.now() >= payload.expiresAt) return undefined;
		return payload;
	} catch {
		return undefined;
	}
}

export function createInvite(teamId: string, invitedBy: string, secret: string): string {
	const now = Date.now();
	return signInvite({ teamId, invitedBy, issuedAt: now, expiresAt: now + INVITE_TTL_MS }, secret);
}
