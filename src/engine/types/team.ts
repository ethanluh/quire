export type TeamRole = "owner" | "admin" | "member";

export interface Team {
	teamId: string; // opaque random id, never a login — renaming a person never breaks this
	name: string;
	createdAt: string;
	createdBy: string; // login of the creator, informational only
}

export interface TeamMembership {
	login: string;
	teamId: string;
	role: TeamRole;
	joinedAt: string;
}

// data/users/<login>/membership.json — the reverse index a login's session resolves
// through to find its active TenantContext. A login can belong to several teams (its own
// auto-provisioned personal team plus any it has joined) but has exactly one active team
// at a time, switched explicitly — see routes/team.ts's /switch.
export interface LoginMembershipIndex {
	teamIds: ReadonlyArray<string>;
	activeTeamId: string;
}

// data/teams/<teamId>/invites.json — a record of every invite link minted for this team,
// so an owner/admin can see who's been invited but hasn't joined yet (the invite token
// itself is stateless/self-verifying and carries no such visibility on its own). `id`
// matches InvitePayload.id, letting /team/join find and stamp the right record on redemption.
export interface InviteRecord {
	id: string;
	invitedBy: string; // login, audit only
	issuedAt: string;
	expiresAt: string;
	redeemedBy?: string;
	redeemedAt?: string;
	revokedAt?: string;
}

export function isTeam(value: unknown): value is Team {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record["teamId"] === "string" &&
		typeof record["name"] === "string" &&
		typeof record["createdAt"] === "string" &&
		typeof record["createdBy"] === "string"
	);
}

function isTeamRole(value: unknown): value is TeamRole {
	return value === "owner" || value === "admin" || value === "member";
}

function isTeamMembership(value: unknown): value is TeamMembership {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record["login"] === "string" &&
		typeof record["teamId"] === "string" &&
		isTeamRole(record["role"]) &&
		typeof record["joinedAt"] === "string"
	);
}

export function isTeamMembershipList(value: unknown): value is ReadonlyArray<TeamMembership> {
	return Array.isArray(value) && value.every(isTeamMembership);
}

export function isLoginMembershipIndex(value: unknown): value is LoginMembershipIndex {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		Array.isArray(record["teamIds"]) &&
		record["teamIds"].every((id) => typeof id === "string") &&
		typeof record["activeTeamId"] === "string"
	);
}

function isInviteRecord(value: unknown): value is InviteRecord {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record["id"] === "string" &&
		typeof record["invitedBy"] === "string" &&
		typeof record["issuedAt"] === "string" &&
		typeof record["expiresAt"] === "string" &&
		(record["redeemedBy"] === undefined || typeof record["redeemedBy"] === "string") &&
		(record["redeemedAt"] === undefined || typeof record["redeemedAt"] === "string") &&
		(record["revokedAt"] === undefined || typeof record["revokedAt"] === "string")
	);
}

export function isInviteRecordList(value: unknown): value is ReadonlyArray<InviteRecord> {
	return Array.isArray(value) && value.every(isInviteRecord);
}
