// PR1 (this file) assigns roles; enforcement lands in a follow-up PR. Reserved now so
// that PR needs zero data migration — every membership already carries a real role.
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
