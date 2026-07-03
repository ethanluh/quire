import { describe, it, expect, afterEach } from "@jest/globals";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InviteAlreadyRedeemedError, LastOwnerError, TeamStore } from "../../src/engine/team/teamStore.js";

describe("TeamStore", () => {
	let dir: string;
	let store: TeamStore;

	afterEach(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	async function setup(): Promise<void> {
		dir = await mkdtemp(join(tmpdir(), "quire-teamstore-"));
		store = new TeamStore(dir);
	}

	it("createTeamForLogin makes the login the sole owner and its only team", async () => {
		await setup();

		const team = await store.createTeamForLogin("alice", "Alice's team");

		expect(team.name).toBe("Alice's team");
		expect(team.createdBy).toBe("alice");
		const members = await store.listMembers(team.teamId);
		expect(members).toEqual([expect.objectContaining({ login: "alice", role: "owner" })]);
		const index = await store.loadMembershipIndex("alice");
		expect(index).toEqual({ teamIds: [team.teamId], activeTeamId: team.teamId });
	});

	it("keepExistingTeams adds a new team alongside ones the login already has", async () => {
		await setup();

		const first = await store.createTeamForLogin("alice", "First team");
		const second = await store.createTeamForLogin("alice", "Second team", { keepExistingTeams: true });

		const index = await store.loadMembershipIndex("alice");
		expect([...(index?.teamIds ?? [])].sort()).toEqual([first.teamId, second.teamId].sort());
		expect(index?.activeTeamId).toBe(second.teamId);
	});

	it("without keepExistingTeams, a fresh team replaces the login's prior team list", async () => {
		await setup();

		await store.createTeamForLogin("alice", "First team");
		const second = await store.createTeamForLogin("alice", "Second team");

		const index = await store.loadMembershipIndex("alice");
		expect(index).toEqual({ teamIds: [second.teamId], activeTeamId: second.teamId });
	});

	it("addMember replaces an existing membership row for the same login rather than duplicating it", async () => {
		await setup();

		const team = await store.createTeamForLogin("alice", "Team");
		await store.addMember(team.teamId, { login: "bob", teamId: team.teamId, role: "member", joinedAt: "t1" });
		await store.addMember(team.teamId, { login: "bob", teamId: team.teamId, role: "admin", joinedAt: "t2" });

		const members = await store.listMembers(team.teamId);
		expect(members.filter((m) => m.login === "bob")).toHaveLength(1);
		expect(members.find((m) => m.login === "bob")?.role).toBe("admin");
	});

	it("removeMember drops only the named login from the roster", async () => {
		await setup();

		const team = await store.createTeamForLogin("alice", "Team");
		await store.addMember(team.teamId, { login: "bob", teamId: team.teamId, role: "member", joinedAt: "t1" });

		await store.removeMember(team.teamId, "bob");

		const members = await store.listMembers(team.teamId);
		expect(members.map((m) => m.login)).toEqual(["alice"]);
	});

	it("setMemberRole updates only the named login's role", async () => {
		await setup();

		const team = await store.createTeamForLogin("alice", "Team");
		await store.addMember(team.teamId, { login: "bob", teamId: team.teamId, role: "member", joinedAt: "t1" });

		await store.setMemberRole(team.teamId, "bob", "admin");

		const members = await store.listMembers(team.teamId);
		expect(members.find((m) => m.login === "alice")?.role).toBe("owner");
		expect(members.find((m) => m.login === "bob")?.role).toBe("admin");
	});

	it("getMembership returns undefined for a login that never joined", async () => {
		await setup();

		const team = await store.createTeamForLogin("alice", "Team");

		expect(await store.getMembership(team.teamId, "stranger")).toBeUndefined();
	});

	it("loadTeam/loadMembershipIndex return undefined when nothing has been persisted yet", async () => {
		await setup();

		expect(await store.loadTeam("no-such-team")).toBeUndefined();
		expect(await store.loadMembershipIndex("nobody")).toBeUndefined();
	});

	it("saveTeam round-trips a rename", async () => {
		await setup();

		const team = await store.createTeamForLogin("alice", "Old name");
		await store.saveTeam({ ...team, name: "New name" });

		expect((await store.loadTeam(team.teamId))?.name).toBe("New name");
	});

	describe("last-owner invariant", () => {
		it("removeMember rejects removing the sole owner when other members remain", async () => {
			await setup();
			const team = await store.createTeamForLogin("alice", "Team");
			await store.addMember(team.teamId, { login: "bob", teamId: team.teamId, role: "member", joinedAt: "t1" });

			await expect(store.removeMember(team.teamId, "alice")).rejects.toBeInstanceOf(LastOwnerError);
			expect((await store.listMembers(team.teamId)).map((m) => m.login)).toContain("alice");
		});

		it("removeMember allows a sole owner to remove themselves when it's a team of one", async () => {
			await setup();
			const team = await store.createTeamForLogin("alice", "Team");

			await store.removeMember(team.teamId, "alice");

			expect(await store.listMembers(team.teamId)).toEqual([]);
		});

		it("removeMember allows removing a co-owner when another owner remains", async () => {
			await setup();
			const team = await store.createTeamForLogin("alice", "Team");
			await store.addMember(team.teamId, { login: "bob", teamId: team.teamId, role: "owner", joinedAt: "t1" });

			await store.removeMember(team.teamId, "alice");

			expect((await store.listMembers(team.teamId)).map((m) => m.login)).toEqual(["bob"]);
		});

		it("setMemberRole rejects demoting the sole owner when other members remain", async () => {
			await setup();
			const team = await store.createTeamForLogin("alice", "Team");
			await store.addMember(team.teamId, { login: "bob", teamId: team.teamId, role: "member", joinedAt: "t1" });

			await expect(store.setMemberRole(team.teamId, "alice", "member")).rejects.toBeInstanceOf(LastOwnerError);
			expect((await store.getMembership(team.teamId, "alice"))?.role).toBe("owner");
		});

		it("setMemberRole allows demoting a co-owner when another owner remains", async () => {
			await setup();
			const team = await store.createTeamForLogin("alice", "Team");
			await store.addMember(team.teamId, { login: "bob", teamId: team.teamId, role: "owner", joinedAt: "t1" });

			await store.setMemberRole(team.teamId, "bob", "member");

			expect((await store.getMembership(team.teamId, "bob"))?.role).toBe("member");
		});
	});

	describe("concurrency", () => {
		it("two concurrent addMember calls for different logins on the same team don't lose a write", async () => {
			await setup();
			const team = await store.createTeamForLogin("alice", "Team");

			await Promise.all([
				store.addMember(team.teamId, { login: "bob", teamId: team.teamId, role: "member", joinedAt: "t1" }),
				store.addMember(team.teamId, { login: "carol", teamId: team.teamId, role: "member", joinedAt: "t1" }),
			]);

			const logins = (await store.listMembers(team.teamId)).map((m) => m.login).sort();
			expect(logins).toEqual(["alice", "bob", "carol"]);
		});

		it("two concurrent demotions of different owners on a two-owner team never both succeed", async () => {
			await setup();
			const team = await store.createTeamForLogin("alice", "Team");
			await store.addMember(team.teamId, { login: "bob", teamId: team.teamId, role: "owner", joinedAt: "t1" });

			const results = await Promise.allSettled([
				store.setMemberRole(team.teamId, "alice", "member"),
				store.setMemberRole(team.teamId, "bob", "member"),
			]);

			const owners = (await store.listMembers(team.teamId)).filter((m) => m.role === "owner");
			expect(owners.length).toBeGreaterThanOrEqual(1);
			expect(results.some((r) => r.status === "rejected")).toBe(true);
		});

		it("resolveActiveMembership called concurrently for a brand-new login provisions exactly one team", async () => {
			await setup();

			const [first, second] = await Promise.all([store.resolveActiveMembership("dave"), store.resolveActiveMembership("dave")]);

			expect(first.teamId).toBe(second.teamId);
			const index = await store.loadMembershipIndex("dave");
			expect(index?.teamIds).toEqual([first.teamId]);
		});
	});

	describe("resolveActiveMembership", () => {
		it("provisions a personal team-of-one on first call", async () => {
			await setup();

			const membership = await store.resolveActiveMembership("erin");

			expect(membership.role).toBe("owner");
			const team = await store.loadTeam(membership.teamId);
			expect(team?.createdBy).toBe("erin");
		});

		it("repairs an index whose active team no longer lists the login as a member", async () => {
			await setup();
			const first = await store.createTeamForLogin("frank", "First");
			const second = await store.createTeamForLogin("frank", "Second", { keepExistingTeams: true });
			// Simulate frank having been removed from "second" (the active team) without the
			// removal's own index cleanup having landed yet.
			await store.removeMember(second.teamId, "frank");

			const membership = await store.resolveActiveMembership("frank");

			expect(membership.teamId).toBe(first.teamId);
			expect((await store.loadMembershipIndex("frank"))?.activeTeamId).toBe(first.teamId);
		});
	});

	describe("releaseLoginFromTeam", () => {
		it("auto-provisions a fresh personal team when it was the login's only one", async () => {
			await setup();
			const only = await store.createTeamForLogin("gina", "Only");

			const updated = await store.releaseLoginFromTeam("gina", only.teamId);

			expect(updated.teamIds).toHaveLength(1);
			expect(updated.activeTeamId).not.toBe(only.teamId);
		});

		it("switches the active team to a remaining one when the departed team was active", async () => {
			await setup();
			const first = await store.createTeamForLogin("hank", "First");
			const second = await store.createTeamForLogin("hank", "Second", { keepExistingTeams: true });

			const updated = await store.releaseLoginFromTeam("hank", second.teamId);

			expect(updated.teamIds).toEqual([first.teamId]);
			expect(updated.activeTeamId).toBe(first.teamId);
		});
	});

	it("rejects a login that doesn't look like a GitHub username before touching the filesystem", async () => {
		await setup();

		await expect(store.loadMembershipIndex("../../etc/passwd")).rejects.toThrow();
	});

	describe("invites", () => {
		it("listInvites is empty for a team with none", async () => {
			await setup();
			const team = await store.createTeamForLogin("ivy", "Ivy's team");

			expect(await store.listInvites(team.teamId)).toEqual([]);
		});

		it("addInvite persists and round-trips a record", async () => {
			await setup();
			const team = await store.createTeamForLogin("ivy", "Ivy's team");
			const record = { id: "inv-1", invitedBy: "ivy", issuedAt: "t0", expiresAt: "t1" };

			await store.addInvite(team.teamId, record);

			expect(await store.listInvites(team.teamId)).toEqual([record]);
			expect(await store.getInvite(team.teamId, "inv-1")).toEqual(record);
		});

		it("markInviteRedeemed stamps redeemedBy/redeemedAt on the matching record only", async () => {
			await setup();
			const team = await store.createTeamForLogin("ivy", "Ivy's team");
			await store.addInvite(team.teamId, { id: "inv-1", invitedBy: "ivy", issuedAt: "t0", expiresAt: "t1" });
			await store.addInvite(team.teamId, { id: "inv-2", invitedBy: "ivy", issuedAt: "t0", expiresAt: "t1" });

			await store.markInviteRedeemed(team.teamId, "inv-1", "jack");

			const invites = await store.listInvites(team.teamId);
			expect(invites.find((i) => i.id === "inv-1")).toMatchObject({ redeemedBy: "jack" });
			expect(invites.find((i) => i.id === "inv-2")?.redeemedBy).toBeUndefined();
		});

		it("markInviteRedeemed is a silent no-op for an unknown id", async () => {
			await setup();
			const team = await store.createTeamForLogin("ivy", "Ivy's team");

			await expect(store.markInviteRedeemed(team.teamId, "does-not-exist", "jack")).resolves.toBeUndefined();
		});

		it("revokeInvite stamps revokedAt on a pending invite", async () => {
			await setup();
			const team = await store.createTeamForLogin("ivy", "Ivy's team");
			await store.addInvite(team.teamId, { id: "inv-1", invitedBy: "ivy", issuedAt: "t0", expiresAt: "t1" });

			await store.revokeInvite(team.teamId, "inv-1");

			expect((await store.getInvite(team.teamId, "inv-1"))?.revokedAt).toBeDefined();
		});

		it("revokeInvite throws for an already-redeemed invite", async () => {
			await setup();
			const team = await store.createTeamForLogin("ivy", "Ivy's team");
			await store.addInvite(team.teamId, { id: "inv-1", invitedBy: "ivy", issuedAt: "t0", expiresAt: "t1" });
			await store.markInviteRedeemed(team.teamId, "inv-1", "jack");

			await expect(store.revokeInvite(team.teamId, "inv-1")).rejects.toBeInstanceOf(InviteAlreadyRedeemedError);
		});

		it("revokeInvite throws for an unknown id", async () => {
			await setup();
			const team = await store.createTeamForLogin("ivy", "Ivy's team");

			await expect(store.revokeInvite(team.teamId, "does-not-exist")).rejects.toThrow();
		});
	});
});
