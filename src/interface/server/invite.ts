import { signToken, verifyToken } from "./signedToken.js";
import type { TeamRole } from "../../engine/types/team.js";

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface InvitePayload {
	teamId: string;
	invitedBy: string; // login, informational/audit only
	issuedAt: number;
	expiresAt: number;
	// Never "owner" — validated at creation (routes/team.ts's InviteSchema) rather than here,
	// since the invite payload itself has no concept of who's creating it or what they're
	// allowed to grant.
	role: TeamRole;
}

function isTeamRole(value: unknown): value is TeamRole {
	return value === "owner" || value === "admin" || value === "member";
}

function isInvitePayload(value: unknown): value is InvitePayload {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record["teamId"] === "string" &&
		typeof record["invitedBy"] === "string" &&
		typeof record["issuedAt"] === "number" &&
		typeof record["expiresAt"] === "number" &&
		isTeamRole(record["role"])
	);
}

// Same base64url-JSON + HMAC-SHA256 shape as session.ts's signSession/verifySession, and
// the same secret — an invite is "a capability granted by whoever holds the server's
// session secret," the same trust root everything else here already uses. Deliberately
// not stateCookie.ts's nonce+cookie pattern: that nonce means nothing outside the cookie
// that stores it, scoped to the browser that started the flow — wrong for a link that
// must be opened by a different person in a different browser with no prior cookie.
export function signInvite(payload: InvitePayload, secret: string): string {
	return signToken(payload, secret);
}

export function verifyInvite(token: string, secret: string): InvitePayload | undefined {
	return verifyToken(token, secret, isInvitePayload);
}

export function createInvite(teamId: string, invitedBy: string, role: TeamRole, secret: string): string {
	const now = Date.now();
	return signInvite({ teamId, invitedBy, issuedAt: now, expiresAt: now + INVITE_TTL_MS, role }, secret);
}
