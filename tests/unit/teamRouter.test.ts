import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals";
import type { Octokit } from "@octokit/rest";
import express from "express";
import type { Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { teamRouter } from "../../src/interface/server/routes/team.js";
import type { BuildOctokit } from "../../src/engine/github/collaborators.js";
import { saveInstallation } from "../../src/engine/github/installation.js";
import type { InstallationBinding, RepoBinding } from "../../src/engine/github/installation.js";
import { TeamStore } from "../../src/engine/team/teamStore.js";
import { createInvite, INVITE_TTL_MS } from "../../src/interface/server/invite.js";
import type { TeamRole } from "../../src/engine/types/team.js";

const SECRET = "test-secret";
const PUBLIC_URL = "http://localhost:3000";

const BINDING: InstallationBinding = {
	installationId: 42,
	accountLogin: "octocat",
	accountType: "Organization",
	boundAt: "2026-06-30T00:00:00.000Z",
};

function repoBindingFixture(overrides: Partial<RepoBinding> & { owner: string; name: string; installationId: number }): RepoBinding {
	return { addedAt: "2026-06-30T00:00:00.000Z", addedBy: "octocat", ...overrides };
}

// Lets the unawaited GitHub-collaborator-sync promise chain (see team.ts's syncCollaboratorAdd/
// syncCollaboratorRemove) settle before assertions run — the route responds before that chain
// resolves, and the chain itself starts with a real fs.readFile (loadInstallation), so a single
// setImmediate/microtask flush isn't reliably enough to observe its side effects; poll instead.
async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

// For asserting a call never happens: there's no condition to poll for, so just give the
// fire-and-forget chain a comparable window to have run.
function settle(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 50));
}

describe("teamRouter", () => {
	let server: Server;
	let baseUrl: string;
	let dataDir: string;
	let store: TeamStore;
	let currentLogin: string | undefined;
	let addCollaboratorMock: jest.Mock;
	let removeCollaboratorMock: jest.Mock;
	let buildOctokit: BuildOctokit;

	function installationPathFor(teamId: string): string {
		return join(dataDir, "teams", teamId, "installation.json");
	}

	// Binds one repo to the team so the sync path actually reaches addCollaborator/
	// removeCollaborator instead of short-circuiting on "no repos bound yet" — most tests
	// below don't call this and rely on that short-circuit, since they're only asserting on
	// the Quire-side team mutation.
	async function bindRepo(teamId: string, overrides: Partial<RepoBinding> = {}): Promise<void> {
		const repo = repoBindingFixture({ owner: "acme-corp", name: "widgets", installationId: 42, ...overrides });
		await saveInstallation(installationPathFor(teamId), { installations: [BINDING], repos: [repo] });
	}

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "quire-teamrouter-"));
		store = new TeamStore(dataDir);
		currentLogin = undefined;

		addCollaboratorMock = jest.fn(async () => undefined);
		removeCollaboratorMock = jest.fn(async () => undefined);
		const fakeOctokit = {
			rest: { repos: { addCollaborator: addCollaboratorMock, removeCollaborator: removeCollaboratorMock } },
		} as unknown as Octokit;
		buildOctokit = jest.fn(() => fakeOctokit);

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
		app.use("/account/team", teamRouter(store, SECRET, PUBLIC_URL, buildOctokit, dataDir));

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

	// Mints an invite token AND persists its backing record, mirroring POST /invite in production
	// (createInvite + store.addInvite). /join now requires the record to exist — single-use and
	// revocation state live there (Findings 3/4) — so a bare token is no longer redeemable.
	async function persistedInviteToken(teamId: string, invitedBy: string, role: TeamRole): Promise<string> {
		const { token, id } = createInvite(teamId, invitedBy, role, SECRET);
		await store.addInvite(teamId, {
			id,
			invitedBy,
			issuedAt: new Date().toISOString(),
			expiresAt: new Date(Date.now() + INVITE_TTL_MS).toISOString(),
			role,
		});
		return token;
	}

	// store.addMember alone puts a login on the roster but not the reverse-index the stub
	// membership middleware above reads to resolve res.locals.membership for THAT login's
	// own requests — needed for every "second team member acts on the API" test case below.
	async function addMemberWithIndex(teamId: string, login: string, role: "owner" | "admin" | "member"): Promise<void> {
		await store.addMember(teamId, { login, teamId, role, joinedAt: "t0" });
		await store.saveMembershipIndex(login, { teamIds: [teamId], activeTeamId: teamId });
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
		const token = await persistedInviteToken(ownerTeamId, "owner", "member");

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
		const token = await persistedInviteToken(ownerTeamId, "owner", "member");
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

	it("POST /join is single-use across different logins (Finding 3)", async () => {
		const ownerTeamId = await signIn("owner");
		const token = await persistedInviteToken(ownerTeamId, "owner", "admin");

		currentLogin = "bob";
		await store.createTeamForLogin("bob", "bob's team");
		const first = await fetch(`${baseUrl}/account/team/join`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ token }),
		});
		expect(first.status).toBe(200);

		// A different login can't reuse the same (admin-granting) link after bob consumed it.
		currentLogin = "mallory";
		await store.createTeamForLogin("mallory", "mallory's team");
		const second = await fetch(`${baseUrl}/account/team/join`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ token }),
		});
		expect(second.status).toBe(400);
		expect(await store.getMembership(ownerTeamId, "mallory")).toBeUndefined();
	});

	it("POST /join rejects a signed token with no persisted invite record (Finding 4)", async () => {
		const ownerTeamId = await signIn("owner");
		// A bare token minted without the /invite route ever persisting a record — single-use and
		// revocation both live in that record, so a missing one must not be honored as unlimited use.
		const { token } = createInvite(ownerTeamId, "owner", "admin", SECRET);

		currentLogin = "bob";
		await store.createTeamForLogin("bob", "bob's team");
		const res = await fetch(`${baseUrl}/account/team/join`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ token }),
		});
		expect(res.status).toBe(400);
		expect(await store.getMembership(ownerTeamId, "bob")).toBeUndefined();
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

	it("PATCH / rejects a plain member with 403", async () => {
		const teamId = await signIn("owner");
		await addMemberWithIndex(teamId, "bob", "member");
		currentLogin = "bob";

		const res = await fetch(`${baseUrl}/account/team`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "Renamed" }),
		});
		expect(res.status).toBe(403);
	});

	it("POST /invite rejects a plain member with 403", async () => {
		const teamId = await signIn("owner");
		await addMemberWithIndex(teamId, "bob", "member");
		currentLogin = "bob";

		const res = await fetch(`${baseUrl}/account/team/invite`, { method: "POST" });
		expect(res.status).toBe(403);
	});

	describe("POST /members/:login/role", () => {
		it("lets an owner promote a member to admin", async () => {
			const teamId = await signIn("owner");
			await store.addMember(teamId, { login: "bob", teamId, role: "member", joinedAt: "t1" });

			const res = await fetch(`${baseUrl}/account/team/members/bob/role`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ role: "admin" }),
			});
			expect(res.status).toBe(200);
			expect((await store.getMembership(teamId, "bob"))?.role).toBe("admin");
		});

		it("lets an admin promote a member to admin (doesn't touch the owner role)", async () => {
			const teamId = await signIn("owner");
			await addMemberWithIndex(teamId, "carol", "admin");
			await store.addMember(teamId, { login: "bob", teamId, role: "member", joinedAt: "t1" });
			currentLogin = "carol";

			const res = await fetch(`${baseUrl}/account/team/members/bob/role`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ role: "admin" }),
			});
			expect(res.status).toBe(200);
		});

		it("blocks an admin from promoting anyone to owner", async () => {
			const teamId = await signIn("owner");
			await addMemberWithIndex(teamId, "carol", "admin");
			await store.addMember(teamId, { login: "bob", teamId, role: "member", joinedAt: "t1" });
			currentLogin = "carol";

			const res = await fetch(`${baseUrl}/account/team/members/bob/role`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ role: "owner" }),
			});
			expect(res.status).toBe(403);
		});

		it("blocks an admin from changing an existing owner's role", async () => {
			const teamId = await signIn("owner");
			await store.addMember(teamId, { login: "second-owner", teamId, role: "owner", joinedAt: "t0" });
			await addMemberWithIndex(teamId, "carol", "admin");
			currentLogin = "carol";

			const res = await fetch(`${baseUrl}/account/team/members/second-owner/role`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ role: "admin" }),
			});
			expect(res.status).toBe(403);
		});

		it("blocks a caller from changing their own role (400, before any other check)", async () => {
			const teamId = await signIn("owner");

			const res = await fetch(`${baseUrl}/account/team/members/owner/role`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ role: "admin" }),
			});
			expect(res.status).toBe(400);
			expect((await store.getMembership(teamId, "owner"))?.role).toBe("owner");
		});

		// The 409 "would leave the team with no owner" case is unreachable through this route
		// once self-action is blocked: touching the owner role requires the caller to already
		// be an owner (see touchesOwnerRole below), so the only caller who could ever demote a
		// *sole* owner is that owner themselves — which the self-action guard above rejects
		// first. The invariant itself still lives in TeamStore.setMemberRole (see
		// teamStore.test.ts's "last-owner invariant" suite) so any other caller — a script, a
		// future route — stays protected.

		it("allows demoting a co-owner when another owner remains", async () => {
			const teamId = await signIn("owner");
			await store.addMember(teamId, { login: "second-owner", teamId, role: "owner", joinedAt: "t0" });

			const res = await fetch(`${baseUrl}/account/team/members/second-owner/role`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ role: "member" }),
			});
			expect(res.status).toBe(200);
		});

		it("404s for a login that isn't on the team", async () => {
			await signIn("owner");

			const res = await fetch(`${baseUrl}/account/team/members/stranger/role`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ role: "admin" }),
			});
			expect(res.status).toBe(404);
		});

		it("rejects a plain member with 403 before even checking the target", async () => {
			const teamId = await signIn("owner");
			await addMemberWithIndex(teamId, "bob", "member");
			currentLogin = "bob";

			const res = await fetch(`${baseUrl}/account/team/members/bob/role`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ role: "admin" }),
			});
			expect(res.status).toBe(403);
		});
	});

	describe("POST /members/:login/remove", () => {
		it("lets an owner remove a member, and the removed login gets a fresh personal team", async () => {
			const teamId = await signIn("owner");
			await store.addMember(teamId, { login: "bob", teamId, role: "member", joinedAt: "t1" });
			await store.saveMembershipIndex("bob", { teamIds: [teamId], activeTeamId: teamId });

			const res = await fetch(`${baseUrl}/account/team/members/bob/remove`, { method: "POST" });
			expect(res.status).toBe(200);

			expect(await store.getMembership(teamId, "bob")).toBeUndefined();
			const bobIndex = await store.loadMembershipIndex("bob");
			expect(bobIndex?.teamIds).toHaveLength(1);
			expect(bobIndex?.activeTeamId).not.toBe(teamId);
		});

		it("switches the removed login's active team to a remaining one if it had others", async () => {
			const teamId = await signIn("owner");
			const bobOwnTeam = await store.createTeamForLogin("bob", "bob's own team");
			await store.addMember(teamId, { login: "bob", teamId, role: "member", joinedAt: "t1" });
			await store.saveMembershipIndex("bob", { teamIds: [bobOwnTeam.teamId, teamId], activeTeamId: teamId });

			const res = await fetch(`${baseUrl}/account/team/members/bob/remove`, { method: "POST" });
			expect(res.status).toBe(200);

			const bobIndex = await store.loadMembershipIndex("bob");
			expect(bobIndex?.teamIds).toEqual([bobOwnTeam.teamId]);
			expect(bobIndex?.activeTeamId).toBe(bobOwnTeam.teamId);
		});

		it("lets an admin remove a plain member", async () => {
			const teamId = await signIn("owner");
			await addMemberWithIndex(teamId, "carol", "admin");
			await store.addMember(teamId, { login: "bob", teamId, role: "member", joinedAt: "t1" });
			currentLogin = "carol";

			const res = await fetch(`${baseUrl}/account/team/members/bob/remove`, { method: "POST" });
			expect(res.status).toBe(200);
		});

		it("blocks an admin from removing an owner", async () => {
			const teamId = await signIn("owner");
			await store.addMember(teamId, { login: "second-owner", teamId, role: "owner", joinedAt: "t0" });
			await addMemberWithIndex(teamId, "carol", "admin");
			currentLogin = "carol";

			const res = await fetch(`${baseUrl}/account/team/members/second-owner/remove`, { method: "POST" });
			expect(res.status).toBe(403);
		});

		it("blocks a caller from removing themselves this way (400)", async () => {
			const teamId = await signIn("owner");

			const res = await fetch(`${baseUrl}/account/team/members/owner/remove`, { method: "POST" });
			expect(res.status).toBe(400);
			expect(await store.getMembership(teamId, "owner")).toBeDefined();
		});

		// The 409 "would leave the team with no owner" case is unreachable through this route
		// once self-action is blocked, for the same reason as /role above: removing an owner
		// requires the caller to already be an owner, so the only caller who could ever remove
		// a *sole* owner is that owner themselves — rejected first. See
		// teamStore.test.ts's "last-owner invariant" suite for the invariant itself.

		it("allows removing a co-owner when another owner remains", async () => {
			const teamId = await signIn("owner");
			await store.addMember(teamId, { login: "second-owner", teamId, role: "owner", joinedAt: "t0" });

			const res = await fetch(`${baseUrl}/account/team/members/second-owner/remove`, { method: "POST" });
			expect(res.status).toBe(200);
		});

		it("404s for a login that isn't on the team", async () => {
			await signIn("owner");

			const res = await fetch(`${baseUrl}/account/team/members/stranger/remove`, { method: "POST" });
			expect(res.status).toBe(404);
		});

		it("rejects a plain member with 403", async () => {
			const teamId = await signIn("owner");
			await addMemberWithIndex(teamId, "bob", "member");
			currentLogin = "bob";

			const res = await fetch(`${baseUrl}/account/team/members/bob/remove`, { method: "POST" });
			expect(res.status).toBe(403);
		});
	});

	describe("GitHub collaborator sync", () => {
		it("POST /join adds the joining login as a collaborator on every bound repo, mapping role to permission", async () => {
			const ownerTeamId = await signIn("owner");
			await bindRepo(ownerTeamId);
			const token = await persistedInviteToken(ownerTeamId, "owner", "admin");
			currentLogin = "bob";
			await store.createTeamForLogin("bob", "bob's team");

			const res = await fetch(`${baseUrl}/account/team/join`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ token }),
			});
			expect(res.status).toBe(200);

			await waitFor(() => addCollaboratorMock.mock.calls.length > 0);
			expect(buildOctokit).toHaveBeenCalledWith(42);
			expect(addCollaboratorMock).toHaveBeenCalledWith({ owner: "acme-corp", repo: "widgets", username: "bob", permission: "push" });
		});

		it("POST /join re-redeemed by an existing lower-role member syncs their actual role, not the invite's — no privilege escalation", async () => {
			const ownerTeamId = await signIn("owner");
			await bindRepo(ownerTeamId);
			// A still-valid admin-role invite (unexpired, unrevoked). bob is ALREADY a member, so
			// his redemption is the idempotent "already a member" path — the guard against a
			// higher-role invite escalating an existing member's role (the sync must use his
			// actual role, not the invite's), independent of single-use enforcement.
			const token = await persistedInviteToken(ownerTeamId, "owner", "admin");
			currentLogin = "bob";
			await addMemberWithIndex(ownerTeamId, "bob", "member");

			const res = await fetch(`${baseUrl}/account/team/join`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ token }),
			});
			expect(res.status).toBe(200);

			// Quire's own record must not change (rejoin is a no-op for role)...
			expect((await store.getMembership(ownerTeamId, "bob"))?.role).toBe("member");
			// ...and the GitHub sync must grant only what that unchanged role warrants, not
			// the higher role embedded in the reused invite token.
			await waitFor(() => addCollaboratorMock.mock.calls.length > 0);
			expect(addCollaboratorMock).toHaveBeenCalledWith({ owner: "acme-corp", repo: "widgets", username: "bob", permission: "pull" });
		});

		it("POST /join is a no-op (not an error) when the team has no repos bound yet", async () => {
			const ownerTeamId = await signIn("owner");
			const token = await persistedInviteToken(ownerTeamId, "owner", "member");
			currentLogin = "bob";
			await store.createTeamForLogin("bob", "bob's team");

			const res = await fetch(`${baseUrl}/account/team/join`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ token }),
			});
			expect(res.status).toBe(200);

			await settle();
			expect(buildOctokit).not.toHaveBeenCalled();
			expect(addCollaboratorMock).not.toHaveBeenCalled();
		});

		it("POST /join never syncs GitHub when the Quire-side join itself fails (invalid token)", async () => {
			await signIn("bob");

			const res = await fetch(`${baseUrl}/account/team/join`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ token: "not-a-real-token" }),
			});
			expect(res.status).toBe(400);

			await settle();
			expect(addCollaboratorMock).not.toHaveBeenCalled();
		});

		it("POST /join responds before the GitHub sync settles (never blocks on it)", async () => {
			const ownerTeamId = await signIn("owner");
			await bindRepo(ownerTeamId);
			const token = await persistedInviteToken(ownerTeamId, "owner", "member");
			currentLogin = "bob";
			await store.createTeamForLogin("bob", "bob's team");

			let releaseGitHubCall: () => void = () => undefined;
			addCollaboratorMock.mockImplementation(() => new Promise((resolve) => (releaseGitHubCall = () => resolve(undefined))));

			// If the route awaited the GitHub sync before responding, this fetch would hang
			// until releaseGitHubCall() is invoked below — it isn't yet, so getting a response
			// at all here is itself the proof the sync never blocks the request.
			const res = await fetch(`${baseUrl}/account/team/join`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ token }),
			});
			expect(res.status).toBe(200);

			await waitFor(() => addCollaboratorMock.mock.calls.length > 0);
			releaseGitHubCall();
		});

		it("POST /leave removes the login as a collaborator on every bound repo", async () => {
			const first = await signIn("alice", "First");
			const second = await store.createTeamForLogin("alice", "Second", { keepExistingTeams: true });
			await bindRepo(second.teamId);
			await store.saveMembershipIndex("alice", { teamIds: [first, second.teamId], activeTeamId: second.teamId });

			const res = await fetch(`${baseUrl}/account/team/leave`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ teamId: second.teamId }),
			});
			expect(res.status).toBe(200);

			await waitFor(() => removeCollaboratorMock.mock.calls.length > 0);
			expect(buildOctokit).toHaveBeenCalledWith(42);
			expect(removeCollaboratorMock).toHaveBeenCalledWith({ owner: "acme-corp", repo: "widgets", username: "alice" });
		});

		it("POST /leave never syncs GitHub when the Quire-side leave itself fails (not a member)", async () => {
			await signIn("alice");

			const res = await fetch(`${baseUrl}/account/team/leave`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ teamId: "not-my-team" }),
			});
			expect(res.status).toBe(400);

			await settle();
			expect(removeCollaboratorMock).not.toHaveBeenCalled();
		});

		it("POST /members/:login/remove removes the target as a collaborator on every bound repo", async () => {
			const teamId = await signIn("owner");
			await bindRepo(teamId);
			await store.addMember(teamId, { login: "bob", teamId, role: "member", joinedAt: "t1" });
			await store.saveMembershipIndex("bob", { teamIds: [teamId], activeTeamId: teamId });

			const res = await fetch(`${baseUrl}/account/team/members/bob/remove`, { method: "POST" });
			expect(res.status).toBe(200);

			await waitFor(() => removeCollaboratorMock.mock.calls.length > 0);
			expect(buildOctokit).toHaveBeenCalledWith(42);
			expect(removeCollaboratorMock).toHaveBeenCalledWith({ owner: "acme-corp", repo: "widgets", username: "bob" });
		});

		it("POST /members/:login/remove never syncs GitHub when the Quire-side removal itself fails (404 unknown login)", async () => {
			const teamId = await signIn("owner");
			await bindRepo(teamId);

			const res = await fetch(`${baseUrl}/account/team/members/stranger/remove`, { method: "POST" });
			expect(res.status).toBe(404);

			await settle();
			expect(removeCollaboratorMock).not.toHaveBeenCalled();
		});

		it("POST /members/:login/role re-syncs GitHub permission for the new role, not just future joins", async () => {
			const teamId = await signIn("owner");
			await bindRepo(teamId);
			await store.addMember(teamId, { login: "bob", teamId, role: "member", joinedAt: "t1" });

			const res = await fetch(`${baseUrl}/account/team/members/bob/role`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ role: "admin" }),
			});
			expect(res.status).toBe(200);

			await waitFor(() => addCollaboratorMock.mock.calls.length > 0);
			expect(addCollaboratorMock).toHaveBeenCalledWith({ owner: "acme-corp", repo: "widgets", username: "bob", permission: "push" });
		});

		it("POST /members/:login/role never syncs GitHub when the Quire-side role change itself fails (self-role-change block)", async () => {
			const teamId = await signIn("owner");
			await bindRepo(teamId);

			const res = await fetch(`${baseUrl}/account/team/members/owner/role`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ role: "admin" }),
			});
			expect(res.status).toBe(400); // blocked earlier: can't change your own role this way

			await settle();
			expect(addCollaboratorMock).not.toHaveBeenCalled();
		});
	});

	describe("GET /collaborator-sync-issues", () => {
		class FakeHttpError extends Error {
			readonly status: number;
			constructor(message: string, status: number) {
				super(message);
				this.name = "HttpError";
				this.status = status;
			}
		}

		it("surfaces a failed sync and clears it once a later sync for the same login/repo succeeds", async () => {
			const teamId = await signIn("owner");
			await bindRepo(teamId);
			addCollaboratorMock.mockImplementationOnce(async () => {
				throw new FakeHttpError("Resource not accessible by integration", 403);
			});
			const token = await persistedInviteToken(teamId, "owner", "member");
			currentLogin = "bob";
			await store.createTeamForLogin("bob", "bob's team");

			await fetch(`${baseUrl}/account/team/join`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ token }),
			});
			await waitFor(() => addCollaboratorMock.mock.calls.length > 0);

			currentLogin = "owner";
			const first = await fetch(`${baseUrl}/account/team/collaborator-sync-issues`);
			expect(first.status).toBe(200);
			const { issues: firstIssues } = (await first.json()) as { issues: Array<{ login: string; reason: string }> };
			expect(firstIssues).toEqual([expect.objectContaining({ login: "bob", owner: "acme-corp", name: "widgets", reason: "insufficient-permission" })]);

			// Re-approve (simulated by the mock no longer rejecting) and retry — a role change
			// re-syncs the same (login, repo, action) key and should clear the earlier issue.
			currentLogin = "owner";
			await fetch(`${baseUrl}/account/team/members/bob/role`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ role: "member" }),
			});
			await waitFor(() => addCollaboratorMock.mock.calls.length > 1);

			const second = await fetch(`${baseUrl}/account/team/collaborator-sync-issues`);
			const { issues: secondIssues } = (await second.json()) as { issues: unknown[] };
			expect(secondIssues).toEqual([]);
		});

		it("rejects a plain member with 403", async () => {
			const teamId = await signIn("owner");
			await addMemberWithIndex(teamId, "bob", "member");
			currentLogin = "bob";

			const res = await fetch(`${baseUrl}/account/team/collaborator-sync-issues`);
			expect(res.status).toBe(403);
		});
	});
});
