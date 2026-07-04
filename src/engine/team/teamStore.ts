import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { readJsonFile, writeJsonFileAtomic } from "../jsonFile.js";
import type { InviteRecord, LoginMembershipIndex, Team, TeamMembership, TeamRole } from "../types/team.js";
import { isInviteRecordList, isLoginMembershipIndex, isTeam, isTeamMembershipList } from "../types/team.js";

// Thrown by revokeInvite when the target invite has already been redeemed — nothing left to
// revoke, and silently succeeding would misleadingly suggest the link stopped working.
export class InviteAlreadyRedeemedError extends Error {}

// A login is always a GitHub username here (requireSession only ever sets it from a
// verified GitHub identity), which GitHub itself restricts to alphanumeric characters and
// hyphens — but it's still externally supplied input joined straight into a filesystem
// path below, so it's validated defensively rather than trusted blindly, the same way
// tenant.ts's sanitizeTeamId validates the (internally-minted) teamId before an identical
// kind of join.
const VALID_LOGIN = /^[A-Za-z0-9-]+$/;

function sanitizeLogin(login: string): string {
	if (!VALID_LOGIN.test(login)) {
		throw new Error(`Refusing to scope team data to unexpected login: ${JSON.stringify(login)}`);
	}
	return login;
}

// Thrown by removeMember/setMemberRole when the change would leave a team that still has
// other members with zero owners. Enforced here rather than in a route handler so every
// caller — /leave's self-removal, an owner/admin removing someone else, any future
// caller — gets the same protection for free, and a concurrent pair of calls (see
// withTeamLock) can never both slip past a stale "someone else is still an owner" check.
export class LastOwnerError extends Error {}

// Thrown by updateMembershipIndex callers (see routes/team.ts's /switch) when the login
// isn't actually a member of the team it's trying to act on.
export class NotAMemberError extends Error {}

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
		return join(this.dataDir, "users", sanitizeLogin(login), "membership.json");
	}

	private invitesPath(teamId: string): string {
		return join(this.dataDir, "teams", teamId, "invites.json");
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

	// load-under-lock, let the caller compute the next roster (it may throw to abort the
	// save — that's how removeMember/setMemberRole enforce the last-owner invariant),
	// save-under-lock. The members-file twin of updateMembershipIndex; serializing per
	// team is what keeps a concurrent pair from both slipping past a stale owner check.
	private updateMembers(
		teamId: string,
		update: (current: ReadonlyArray<TeamMembership>) => ReadonlyArray<TeamMembership>,
	): Promise<void> {
		return this.withTeamLock(teamId, async () => {
			const existing = await this.listMembers(teamId);
			await this.saveMembers(teamId, update(existing));
		});
	}

	// Chains async work per key onto whatever's already pending for that key (the same
	// per-key-promise-chaining pattern refreshRepoQueue.ts's enqueueRefresh uses for its
	// coalescing lock) — every roster mutation below runs through `teamLocks`, every
	// membership-index mutation through `loginLocks`, so two concurrent calls for the same
	// team/login can never both read the same stale snapshot before either writes.
	private readonly teamLocks = new Map<string, Promise<unknown>>();
	private readonly loginLocks = new Map<string, Promise<unknown>>();

	private lockOn<T>(locks: Map<string, Promise<unknown>>, key: string, fn: () => Promise<T>): Promise<T> {
		const previous = locks.get(key) ?? Promise.resolve();
		const run = previous.catch(() => undefined).then(fn);
		locks.set(key, run);
		run.finally(() => {
			if (locks.get(key) === run) locks.delete(key);
		}).catch(() => undefined);
		return run;
	}

	private withTeamLock<T>(teamId: string, fn: () => Promise<T>): Promise<T> {
		return this.lockOn(this.teamLocks, teamId, fn);
	}

	private withLoginLock<T>(login: string, fn: () => Promise<T>): Promise<T> {
		return this.lockOn(this.loginLocks, login, fn);
	}

	async addMember(teamId: string, membership: TeamMembership): Promise<void> {
		return this.updateMembers(teamId, (existing) => {
			const withoutLogin = existing.filter((m) => m.login !== membership.login);
			return [...withoutLogin, membership];
		});
	}

	// Refuses to remove the last owner from a team that would still have other members
	// left afterward — a team someone else depends on must always keep an owner. A sole
	// member removing themselves (the team becomes empty) is exempt: there's no one left
	// to be ownerless. Applies uniformly to /leave's self-removal and an owner/admin
	// removing someone else, so both go through one invariant instead of two.
	async removeMember(teamId: string, login: string): Promise<void> {
		return this.updateMembers(teamId, (existing) => {
			const removedWasOwner = existing.some((m) => m.login === login && m.role === "owner");
			const remaining = existing.filter((m) => m.login !== login);
			if (removedWasOwner && remaining.length > 0 && !remaining.some((m) => m.role === "owner")) {
				throw new LastOwnerError(`Removing ${login} would leave team ${teamId} with members but no owner`);
			}
			return remaining;
		});
	}

	async setMemberRole(teamId: string, login: string, role: TeamRole): Promise<void> {
		return this.updateMembers(teamId, (existing) => {
			const updated = existing.map((m) => (m.login === login ? { ...m, role } : m));
			const hadOwner = existing.some((m) => m.role === "owner");
			const stillHasOwner = updated.some((m) => m.role === "owner");
			if (hadOwner && !stillHasOwner) {
				throw new LastOwnerError(`Changing ${login}'s role would leave team ${teamId} with no owner`);
			}
			return updated;
		});
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

	// Every login-level membership.json mutation that isn't createTeamForLogin's own
	// (create/switch/join) goes through this: load-under-lock, let the caller compute the
	// next value from the current one, save-under-lock. Serializing per login here is what
	// prevents two concurrent requests for the same login (a page load firing parallel
	// requests, two browser tabs) from each computing a next value off the same stale
	// snapshot and clobbering each other's write.
	async updateMembershipIndex(
		login: string,
		update: (current: LoginMembershipIndex | undefined) => LoginMembershipIndex,
	): Promise<LoginMembershipIndex> {
		return this.withLoginLock(login, async () => {
			const current = await this.loadMembershipIndex(login);
			const next = update(current);
			await this.saveMembershipIndex(login, next);
			return next;
		});
	}

	// Raw team creation: makes `login` the sole owner of a brand-new team. Deliberately
	// does not touch the login's membership index — callers decide how the index should
	// change (replace vs. append vs. repair) under their own lock scope. This is what lets
	// resolveActiveMembership below call it from inside its own withLoginLock callback
	// without deadlocking on a re-entrant lock for the same login.
	private async createTeam(login: string, name: string): Promise<Team> {
		const teamId = randomBytes(12).toString("hex");
		const now = new Date().toISOString();
		const team: Team = { teamId, name, createdAt: now, createdBy: login };
		await this.saveTeam(team);
		await this.addMember(teamId, { login, teamId, role: "owner", joinedAt: now });
		return team;
	}

	// Creates a brand-new team with `login` as its sole owner, and — unless `keepExistingTeams`
	// is set — makes it the login's one and only team. `keepExistingTeams: true` is what
	// /account/team/create uses (a login gaining an additional team alongside ones it already
	// has); omitted (the default) is what migrateLegacyData uses, where there's no prior
	// index to preserve.
	async createTeamForLogin(login: string, name: string, opts?: { keepExistingTeams?: boolean }): Promise<Team> {
		const team = await this.createTeam(login, name);
		await this.withLoginLock(login, async () => {
			const previous = opts?.keepExistingTeams === true ? await this.loadMembershipIndex(login) : undefined;
			const kept = (previous?.teamIds ?? []).filter((id) => id !== team.teamId);
			const teamIds = [...kept, team.teamId];
			await this.saveMembershipIndex(login, { teamIds, activeTeamId: team.teamId });
		});
		return team;
	}

	// Resolves a login's active {teamId, role}, auto-provisioning a personal team-of-one on
	// its first-ever call. The provision-if-missing check and the provisioning itself run
	// inside one login-lock scope, so two concurrent first requests for a brand-new login
	// can never each provision their own team — the second sees the first's freshly created
	// index instead of racing it. Also repairs an index whose active team no longer lists
	// this login as a member (e.g. it was removed by an owner and the removal's own index
	// cleanup crashed or raced before landing) by falling back to another team the index
	// still claims, or provisioning a fresh one, instead of failing every request from this
	// login until an operator fixes the file by hand.
	async resolveActiveMembership(login: string): Promise<TeamMembership> {
		return this.withLoginLock(login, async () => {
			const current = await this.loadMembershipIndex(login);
			if (current !== undefined) {
				const membership = await this.getMembership(current.activeTeamId, login);
				if (membership !== undefined) return membership;

				for (const teamId of current.teamIds) {
					if (teamId === current.activeTeamId) continue;
					const fallback = await this.getMembership(teamId, login);
					if (fallback !== undefined) {
						await this.saveMembershipIndex(login, { teamIds: current.teamIds, activeTeamId: teamId });
						return fallback;
					}
				}
			}

			const team = await this.createTeam(login, `${login}'s team`);
			await this.saveMembershipIndex(login, { teamIds: [team.teamId], activeTeamId: team.teamId });
			const membership = await this.getMembership(team.teamId, login);
			if (membership === undefined) throw new Error(`Failed to provision a team for ${login}`);
			return membership;
		});
	}

	// Removes `teamId` from `login`'s membership index, auto-provisioning a fresh personal
	// team if that would leave them teamless, or switching their active team to a remaining
	// one if the departed team was active. Shared by /leave (a login leaving its own team)
	// and an owner/admin removing someone else, so both go through one "never leave a login
	// teamless" guarantee instead of two independently-maintained copies.
	async releaseLoginFromTeam(login: string, teamId: string): Promise<LoginMembershipIndex> {
		return this.withLoginLock(login, async () => {
			const current = await this.loadMembershipIndex(login);
			const remainingTeamIds = (current?.teamIds ?? []).filter((id) => id !== teamId);

			if (remainingTeamIds.length === 0) {
				const team = await this.createTeam(login, `${login}'s team`);
				const fresh: LoginMembershipIndex = { teamIds: [team.teamId], activeTeamId: team.teamId };
				await this.saveMembershipIndex(login, fresh);
				return fresh;
			}

			const fallbackTeamId = remainingTeamIds[0] ?? teamId;
			const activeTeamId = current?.activeTeamId === teamId ? fallbackTeamId : (current?.activeTeamId ?? fallbackTeamId);
			const next: LoginMembershipIndex = { teamIds: remainingTeamIds, activeTeamId };
			await this.saveMembershipIndex(login, next);
			return next;
		});
	}

	async listInvites(teamId: string): Promise<ReadonlyArray<InviteRecord>> {
		return (await readJsonFile(this.invitesPath(teamId), isInviteRecordList)) ?? [];
	}

	private async saveInvites(teamId: string, invites: ReadonlyArray<InviteRecord>): Promise<void> {
		await writeJsonFileAtomic(this.invitesPath(teamId), invites);
	}

	// Records that an invite link was minted, so an owner/admin can later see it's still
	// pending (see /team/invites) even though the token itself carries no queryable state.
	async addInvite(teamId: string, record: InviteRecord): Promise<void> {
		return this.withTeamLock(teamId, async () => {
			const existing = await this.listInvites(teamId);
			await this.saveInvites(teamId, [...existing, record]);
		});
	}

	// Called by /team/join on successful redemption. Silently a no-op if the record is
	// missing (e.g. it predates this feature) — the token itself already proved the invite
	// was valid; this is bookkeeping for visibility, not a second authorization check.
	async markInviteRedeemed(teamId: string, id: string, redeemedBy: string): Promise<void> {
		return this.withTeamLock(teamId, async () => {
			const existing = await this.listInvites(teamId);
			const updated = existing.map((invite) =>
				invite.id === id ? { ...invite, redeemedBy, redeemedAt: new Date().toISOString() } : invite,
			);
			await this.saveInvites(teamId, updated);
		});
	}

	async getInvite(teamId: string, id: string): Promise<InviteRecord | undefined> {
		const invites = await this.listInvites(teamId);
		return invites.find((invite) => invite.id === id);
	}

	// Marks an invite as revoked so its still-valid-looking token stops being honorable by
	// /team/join, without needing to invalidate the whole team's session secret. Throws if
	// the invite was already redeemed (nothing meaningful left to revoke) or doesn't exist.
	async revokeInvite(teamId: string, id: string): Promise<void> {
		return this.withTeamLock(teamId, async () => {
			const existing = await this.listInvites(teamId);
			const target = existing.find((invite) => invite.id === id);
			if (target === undefined) {
				throw new Error(`No invite ${id} found for team ${teamId}`);
			}
			if (target.redeemedAt !== undefined) {
				throw new InviteAlreadyRedeemedError(`Invite ${id} was already redeemed by ${target.redeemedBy}`);
			}
			const updated = existing.map((invite) => (invite.id === id ? { ...invite, revokedAt: new Date().toISOString() } : invite));
			await this.saveInvites(teamId, updated);
		});
	}
}
