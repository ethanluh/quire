import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { readJsonFile, writeJsonFileAtomic } from "../jsonFile.js";
import type { LoginMembershipIndex, Team, TeamMembership, TeamRole } from "../types/team.js";
import { isLoginMembershipIndex, isTeam, isTeamMembershipList } from "../types/team.js";

// Every team-shaped file this store reads/writes lives under dataDir, either per-team
// (data/teams/<teamId>/{team,members}.json) or per-login (data/users/<login>/membership.json)
// — the same two roots tenant.ts already uses for everything else a login/team owns.
export class TeamStore {
	constructor(private readonly dataDir: string) {}

	private teamPath(teamId: string): string {
		return join(this.dataDir, "teams", teamId, "team.json");
	}

	private membersPath(teamId: string): string {
		return join(this.dataDir, "teams", teamId, "members.json");
	}

	private membershipIndexPath(login: string): string {
		return join(this.dataDir, "users", login, "membership.json");
	}

	async loadTeam(teamId: string): Promise<Team | undefined> {
		return readJsonFile(this.teamPath(teamId), isTeam);
	}

	async saveTeam(team: Team): Promise<void> {
		await writeJsonFileAtomic(this.teamPath(team.teamId), team);
	}

	async listMembers(teamId: string): Promise<ReadonlyArray<TeamMembership>> {
		return (await readJsonFile(this.membersPath(teamId), isTeamMembershipList)) ?? [];
	}

	private async saveMembers(teamId: string, members: ReadonlyArray<TeamMembership>): Promise<void> {
		await writeJsonFileAtomic(this.membersPath(teamId), members);
	}

	async addMember(teamId: string, membership: TeamMembership): Promise<void> {
		const existing = await this.listMembers(teamId);
		const withoutLogin = existing.filter((m) => m.login !== membership.login);
		await this.saveMembers(teamId, [...withoutLogin, membership]);
	}

	async removeMember(teamId: string, login: string): Promise<void> {
		const existing = await this.listMembers(teamId);
		await this.saveMembers(teamId, existing.filter((m) => m.login !== login));
	}

	async setMemberRole(teamId: string, login: string, role: TeamRole): Promise<void> {
		const existing = await this.listMembers(teamId);
		await this.saveMembers(
			teamId,
			existing.map((m) => (m.login === login ? { ...m, role } : m)),
		);
	}

	async getMembership(teamId: string, login: string): Promise<TeamMembership | undefined> {
		const members = await this.listMembers(teamId);
		return members.find((m) => m.login === login);
	}

	async loadMembershipIndex(login: string): Promise<LoginMembershipIndex | undefined> {
		return readJsonFile(this.membershipIndexPath(login), isLoginMembershipIndex);
	}

	async saveMembershipIndex(login: string, index: LoginMembershipIndex): Promise<void> {
		await writeJsonFileAtomic(this.membershipIndexPath(login), index);
	}

	// Creates a brand-new team with `login` as its sole owner, and — unless `keepExistingTeams`
	// is set — makes it the login's one and only team. `keepExistingTeams: true` is what
	// /account/team/create uses (a login gaining an additional team alongside ones it already
	// has); omitted (the default) is what first-login auto-provisioning and /join use, where
	// there's no prior index to preserve.
	async createTeamForLogin(
		login: string,
		name: string,
		opts?: { keepExistingTeams?: boolean },
	): Promise<Team> {
		const teamId = randomBytes(12).toString("hex");
		const now = new Date().toISOString();
		const team: Team = { teamId, name, createdAt: now, createdBy: login };
		await this.saveTeam(team);
		await this.addMember(teamId, { login, teamId, role: "owner", joinedAt: now });

		const previous = opts?.keepExistingTeams === true ? await this.loadMembershipIndex(login) : undefined;
		const teamIds = [...(previous?.teamIds ?? []).filter((id) => id !== teamId), teamId];
		await this.saveMembershipIndex(login, { teamIds, activeTeamId: teamId });

		return team;
	}
}
