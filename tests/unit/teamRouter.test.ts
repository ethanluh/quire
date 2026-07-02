import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import express from "express";
import type { Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { teamRouter } from "../../src/interface/server/routes/team.js";
import { TeamStore } from "../../src/engine/team/teamStore.js";
import { createInvite } from "../../src/interface/server/invite.js";

const SECRET = "test-secret";
const PUBLIC_URL = "http://localhost:3000";

describe("teamRouter", () => {
	let server: Server;
	let baseUrl: string;
	let dataDir: string;
	let store: TeamStore;
	let currentLogin: string | undefined;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "quire-teamrouter-"));
		store = new TeamStore(dataDir);
		currentLogin = undefined;

		const app = express();
		app.use(express.json());
		// Stands in for requireSession + resolveMembership: real routes always run behind
		// both, but this router only reads res.locals.login/membership, so a test-only
		// stub that sets exactly those locals is enough to exercise it in isolation.
		app.use(async (_req, res, next) => {
			if (currentLogin === undefined) {
				res.status(401).json({ error: "Sign in required" });
				return;
			}
			res.locals.login = currentLogin;
			const index = await store.loadMembershipIndex(currentLogin);
			if (index !== undefined) {
				const membership = await store.getMembership(index.activeTeamId, currentLogin);
				if (membership !== undefined) res.locals.membership = { teamId: index.activeTeamId, role: membership.role };
			}
			next();
		});
		app.use("/account/team", teamRouter(store, SECRET, PUBLIC_URL));

		await new Promise<void>((resolve) => {
			server = app.listen(0, resolve);
		});
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("expected AddressInfo");
		baseUrl = `http://127.0.0.1:${address.port}`;
	});

	afterEach(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(dataDir, { recursive: true, force: true });
	});

	async function signIn(login: string, teamName = `${login}'s team`): Promise<string> {
		currentLogin = login;
		const team = await store.createTeamForLogin(login, teamName);
		return team.teamId;
	}

	it("GET / returns the active team with the caller's role and full roster", async () => {
		const teamId = await signIn("alice");

		const res = await fetch(`${baseUrl}/account/team`);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			teamId,
			name: "alice's team",
			role: "owner",
			members: [expect.objectContaining({ login: "alice", role: "owner" })],
		});
	});

	it("GET / 401s without a signed-in login", async () => {
		const res = await fetch(`${baseUrl}/account/team`);
		expect(res.status).toBe(401);
	});

	it("GET /list flags exactly the active team and includes every team the login belongs to", async () => {
		const first = await signIn("alice", "First");
		const second = await store.createTeamForLogin("alice", "Second", { keepExistingTeams: true });

		const res = await fetch(`${baseUrl}/account/team/list`);
		const { teams } = (await res.json()) as { teams: Array<{ teamId: string; active: boolean }> };

		expect(teams.map((t) => t.teamId).sort()).toEqual([first, second.teamId].sort());
		expect(teams.find((t) => t.teamId === second.teamId)?.active).toBe(true);
		expect(teams.find((t) => t.teamId === first)?.active).toBe(false);
	});

	it("POST /create adds a new team without dropping the login's existing ones", async () => {
		const first = await signIn("alice", "First");

		const res = await fetch(`${baseUrl}/account/team/create`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "Second" }),
		});
		expect(res.status).toBe(200);

		const index = await store.loadMembershipIndex("alice");
		expect(index?.teamIds).toHaveLength(2);
		expect(index?.teamIds).toContain(first);
		expect(index?.activeTeamId).not.toBe(first);
	});

	it("PATCH / renames the caller's active team", async () => {
		const teamId = await signIn("alice");

		const res = await fetch(`${baseUrl}/account/team`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "Renamed" }),
		});
		expect(res.status).toBe(200);
		expect((await store.loadTeam(teamId))?.name).toBe("Renamed");
	});

	it("POST /switch moves the active team when the login is a member of the target", async () => {
		const first = await signIn("alice", "First");
		const second = await store.createTeamForLogin("alice", "Second", { keepExistingTeams: true });
		await store.saveMembershipIndex("alice", { teamIds: [first, second.teamId], activeTeamId: second.teamId });

		const res = await fetch(`${baseUrl}/account/team/switch`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ teamId: first }),
		});
		expect(res.status).toBe(200);
		expect((await store.loadMembershipIndex("alice"))?.activeTeamId).toBe(first);
	});

	it("POST /switch rejects a team the login never joined", async () => {
		await signIn("alice");

		const res = await fetch(`${baseUrl}/account/team/switch`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ teamId: "someone-elses-team" }),
		});
		expect(res.status).toBe(403);
	});

	it("POST /invite returns a link whose token verifies for the caller's active team", async () => {
		const teamId = await signIn("alice");

		const res = await fetch(`${baseUrl}/account/team/invite`, { method: "POST" });
		expect(res.status).toBe(200);
		const { inviteUrl } = (await res.json()) as { inviteUrl: string };

		const token = new URL(inviteUrl).searchParams.get("joinTeam");
		expect(token).not.toBeNull();
		const { verifyInvite } = await import("../../src/interface/server/invite.js");
		expect(verifyInvite(token as string, SECRET)?.teamId).toBe(teamId);
	});

	it("POST /join adds the invited login as a member and switches their active team to it", async () => {
		const ownerTeamId = await signIn("owner");
		const token = createInvite(ownerTeamId, "owner", SECRET);

		currentLogin = "bob";
		await store.createTeamForLogin("bob", "bob's team"); // bob already has his own personal team

		const res = await fetch(`${baseUrl}/account/team/join`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ token }),
		});
		expect(res.status).toBe(200);

		const membership = await store.getMembership(ownerTeamId, "bob");
		expect(membership?.role).toBe("member");
		const index = await store.loadMembershipIndex("bob");
		expect(index?.activeTeamId).toBe(ownerTeamId);
		expect(index?.teamIds).toContain(ownerTeamId);
	});

	it("POST /join rejects an invalid or tampered token", async () => {
		await signIn("bob");

		const res = await fetch(`${baseUrl}/account/team/join`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ token: "not-a-real-token" }),
		});
		expect(res.status).toBe(400);
	});

	it("POST /join is idempotent when the login is already a member", async () => {
		const ownerTeamId = await signIn("owner");
		const token = createInvite(ownerTeamId, "owner", SECRET);
		currentLogin = "bob";
		await store.createTeamForLogin("bob", "bob's team");

		await fetch(`${baseUrl}/account/team/join`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ token }),
		});
		await fetch(`${baseUrl}/account/team/join`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ token }),
		});

		const members = await store.listMembers(ownerTeamId);
		expect(members.filter((m) => m.login === "bob")).toHaveLength(1);
	});

	it("POST /leave removes the membership and, if it was active, switches to a remaining team", async () => {
		const first = await signIn("alice", "First");
		const second = await store.createTeamForLogin("alice", "Second", { keepExistingTeams: true });

		const res = await fetch(`${baseUrl}/account/team/leave`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ teamId: second.teamId }),
		});
		expect(res.status).toBe(200);

		const index = await store.loadMembershipIndex("alice");
		expect(index?.teamIds).toEqual([first]);
		expect(index?.activeTeamId).toBe(first);
		expect(await store.getMembership(second.teamId, "alice")).toBeUndefined();
	});

	it("POST /leave auto-provisions a fresh personal team when it was the login's only one", async () => {
		const only = await signIn("alice");

		const res = await fetch(`${baseUrl}/account/team/leave`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ teamId: only }),
		});
		expect(res.status).toBe(200);

		const index = await store.loadMembershipIndex("alice");
		expect(index?.teamIds).toHaveLength(1);
		expect(index?.activeTeamId).not.toBe(only);
		expect(await store.getMembership(only, "alice")).toBeUndefined();
	});

	it("POST /leave rejects a team the login isn't a member of", async () => {
		await signIn("alice");

		const res = await fetch(`${baseUrl}/account/team/leave`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ teamId: "not-my-team" }),
		});
		expect(res.status).toBe(400);
	});
});
