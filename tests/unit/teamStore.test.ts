import { describe, it, expect, afterEach } from "@jest/globals";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TeamStore } from "../../src/engine/team/teamStore.js";

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
});
