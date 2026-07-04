import { join } from "node:path";
import { Router } from "express";
import { z } from "zod";
import type { TeamStore } from "../../../engine/team/teamStore.js";
import { InviteAlreadyRedeemedError, LastOwnerError, NotAMemberError } from "../../../engine/team/teamStore.js";
import { addTeamMemberAsCollaborator, removeTeamMemberAsCollaborator } from "../../../engine/github/collaborators.js";
import type { BuildOctokit, CollaboratorSyncResult } from "../../../engine/github/collaborators.js";
import type { TeamRole } from "../../../engine/types/team.js";
import { createInvite, verifyInvite, INVITE_TTL_MS } from "../invite.js";
import { validateBody } from "../middleware/validation.js";
import { requireRole } from "../middleware/requireRole.js";

const CreateTeamSchema = z.object({ name: z.string().min(1) });
const RenameTeamSchema = z.object({ name: z.string().min(1) });
const SwitchTeamSchema = z.object({ teamId: z.string().min(1) });
const JoinTeamSchema = z.object({ token: z.string().min(1) });
const LeaveTeamSchema = z.object({ teamId: z.string().min(1) });
const ChangeRoleSchema = z.object({ role: z.enum(["owner", "admin", "member"]) });
// Never "owner" — an invite grants membership, not top-level custody; promoting someone to
// owner is always the separate, explicit POST /team/members/:login/role path. Optional (and
// the whole schema wrapped optional below) so a client that posts no body at all — today's
// only caller — still defaults to "member" rather than 400ing.
const InviteSchema = z.object({ role: z.enum(["admin", "member"]).optional() }).optional();

// Mounted right after resolveMembership and before resolveTenant (see index.ts) —
// unlike githubAppRouter/llmAccountRouter, nothing here touches a TenantContext (GitHub
// client, merge queue, ...), only the login-level membership index and the team roster,
// so there's no reason to pay for resolving/loading a tenant just to manage team
// membership.
export function teamRouter(
	teamStore: TeamStore,
	sessionSecret: string,
	publicUrl: string,
	buildOctokit: BuildOctokit,
	dataDir: string,
): Router {
	const router = Router();

	function installationPathFor(teamId: string): string {
		return join(dataDir, "teams", teamId, "installation.json");
	}

	// Logs the outcome of a fire-and-forget GitHub collaborator sync. An empty results array
	// means the team has no repos bound yet — a no-op, not an error. Each per-repo failure is
	// split further so an operator can tell "the App's permission isn't approved" (points at
	// the README) from any other GitHub-side error (logs the raw error for debugging).
	function logCollaboratorSyncResults(
		action: "add" | "remove",
		teamId: string,
		login: string,
		results: ReadonlyArray<CollaboratorSyncResult>,
	): void {
		if (results.length === 0) {
			console.log(`Skipped GitHub collaborator ${action} for ${login} on team ${teamId}: no repos bound yet`);
			return;
		}
		for (const result of results) {
			if (result.outcome !== "failed") continue;
			if (result.reason === "insufficient-permission") {
				console.error(
					`GitHub collaborator ${action} failed for ${login} on team ${teamId} (${result.owner}/${result.name}): the GitHub ` +
						`App is missing the "Administration: Read & write" permission (or an existing installation hasn't re-approved ` +
						`it yet). See README.md's "GitHub App setup" section.`,
				);
			} else {
				console.error(
					`GitHub collaborator ${action} failed for ${login} on team ${teamId} (${result.owner}/${result.name}):`,
					result.error,
				);
			}
		}
	}

	function syncCollaboratorAdd(teamId: string, login: string, role: TeamRole): void {
		addTeamMemberAsCollaborator(buildOctokit, installationPathFor(teamId), login, role)
			.then((results) => logCollaboratorSyncResults("add", teamId, login, results))
			.catch((err: unknown) =>
				console.error(`Unexpected error syncing GitHub collaborator add for ${login} on team ${teamId}:`, err),
			);
	}

	function syncCollaboratorRemove(teamId: string, login: string): void {
		removeTeamMemberAsCollaborator(buildOctokit, installationPathFor(teamId), login)
			.then((results) => logCollaboratorSyncResults("remove", teamId, login, results))
			.catch((err: unknown) =>
				console.error(`Unexpected error syncing GitHub collaborator removal for ${login} on team ${teamId}:`, err),
			);
	}

	router.get("/", async (_req, res, next) => {
		try {
			const membership = res.locals.membership;
			if (membership === undefined) {
				res.status(401).json({ error: "Sign in required" });
				return;
			}
			const team = await teamStore.loadTeam(membership.teamId);
			if (team === undefined) {
				res.status(404).json({ error: "Team not found" });
				return;
			}
			const members = await teamStore.listMembers(membership.teamId);
			res.json({ teamId: team.teamId, name: team.name, role: membership.role, members });
		} catch (err) {
			next(err);
		}
	});

	router.get("/list", async (_req, res, next) => {
		try {
			const login = res.locals.login;
			if (login === undefined) {
				res.status(401).json({ error: "Sign in required" });
				return;
			}
			const index = await teamStore.loadMembershipIndex(login);
			const teams = await Promise.all(
				(index?.teamIds ?? []).map(async (teamId) => {
					const [team, membership] = await Promise.all([teamStore.loadTeam(teamId), teamStore.getMembership(teamId, login)]);
					if (team === undefined || membership === undefined) return undefined;
					return { teamId, name: team.name, role: membership.role, active: teamId === index?.activeTeamId };
				}),
			);
			res.json({ teams: teams.filter((t): t is NonNullable<typeof t> => t !== undefined) });
		} catch (err) {
			next(err);
		}
	});

	// "Create" rather than "convert my personal team": a login keeps every team it already
	// belongs to and gains a new one it's the sole owner of, switched to as the active team.
	router.post("/create", validateBody(CreateTeamSchema), async (req, res, next) => {
		try {
			const login = res.locals.login;
			if (login === undefined) {
				res.status(401).json({ error: "Sign in required" });
				return;
			}
			const { name } = req.body as z.infer<typeof CreateTeamSchema>;
			const team = await teamStore.createTeamForLogin(login, name, { keepExistingTeams: true });
			res.json({ teamId: team.teamId, name: team.name });
		} catch (err) {
			next(err);
		}
	});

	router.patch("/", requireRole("owner", "admin"), validateBody(RenameTeamSchema), async (req, res, next) => {
		try {
			const membership = res.locals.membership;
			if (membership === undefined) {
				res.status(401).json({ error: "Sign in required" });
				return;
			}
			const { name } = req.body as z.infer<typeof RenameTeamSchema>;
			const team = await teamStore.loadTeam(membership.teamId);
			if (team === undefined) {
				res.status(404).json({ error: "Team not found" });
				return;
			}
			await teamStore.saveTeam({ ...team, name });
			res.json({ teamId: team.teamId, name });
		} catch (err) {
			next(err);
		}
	});

	router.post("/switch", validateBody(SwitchTeamSchema), async (req, res, next) => {
		try {
			const login = res.locals.login;
			if (login === undefined) {
				res.status(401).json({ error: "Sign in required" });
				return;
			}
			const { teamId } = req.body as z.infer<typeof SwitchTeamSchema>;
			try {
				await teamStore.updateMembershipIndex(login, (current) => {
					if (current === undefined || !current.teamIds.includes(teamId)) {
						throw new NotAMemberError();
					}
					return { teamIds: current.teamIds, activeTeamId: teamId };
				});
			} catch (err) {
				if (err instanceof NotAMemberError) {
					res.status(403).json({ error: "You are not a member of that team" });
					return;
				}
				throw err;
			}
			res.json({ activeTeamId: teamId });
		} catch (err) {
			next(err);
		}
	});

	router.post("/invite", requireRole("owner", "admin"), validateBody(InviteSchema), async (req, res, next) => {
		try {
			const membership = res.locals.membership;
			const login = res.locals.login;
			if (membership === undefined || login === undefined) {
				res.status(401).json({ error: "Sign in required" });
				return;
			}
			const role = (req.body as z.infer<typeof InviteSchema>)?.role ?? "member";
			const { token, id } = createInvite(membership.teamId, login, role, sessionSecret);
			const now = new Date();
			await teamStore.addInvite(membership.teamId, {
				id,
				invitedBy: login,
				issuedAt: now.toISOString(),
				expiresAt: new Date(now.getTime() + INVITE_TTL_MS).toISOString(),
				role,
			});
			res.json({ inviteUrl: `${publicUrl}/?joinTeam=${token}`, role });
		} catch (err) {
			next(err);
		}
	});

	// Owner/admin only, matching every other roster-composition route — an invite link is a
	// capability to join, so who's holding an unredeemed one is the same class of information
	// as the roster itself. `status` is derived, not stored, so revocation/expiry/redemption
	// never need reconciling against "now" in more than one place.
	router.get("/invites", requireRole("owner", "admin"), async (_req, res, next) => {
		try {
			const membership = res.locals.membership;
			if (membership === undefined) {
				res.status(401).json({ error: "Sign in required" });
				return;
			}
			const invites = await teamStore.listInvites(membership.teamId);
			const now = Date.now();
			const withStatus = invites.map((invite) => ({
				...invite,
				status:
					invite.redeemedAt !== undefined
						? "redeemed"
						: invite.revokedAt !== undefined
							? "revoked"
							: new Date(invite.expiresAt).getTime() < now
								? "expired"
								: "pending",
			}));
			res.json({ invites: withStatus });
		} catch (err) {
			next(err);
		}
	});

	router.delete("/invites/:id", requireRole("owner", "admin"), async (req, res, next) => {
		try {
			const membership = res.locals.membership;
			if (membership === undefined) {
				res.status(401).json({ error: "Sign in required" });
				return;
			}
			const id = req.params["id"] ?? "";
			const existing = await teamStore.getInvite(membership.teamId, id);
			if (existing === undefined) {
				res.status(404).json({ error: "Invite not found" });
				return;
			}
			try {
				await teamStore.revokeInvite(membership.teamId, id);
			} catch (err) {
				if (err instanceof InviteAlreadyRedeemedError) {
					res.status(409).json({ error: "This invite was already redeemed — there's nothing left to revoke" });
					return;
				}
				throw err;
			}
			res.json({ id, revoked: true });
		} catch (err) {
			next(err);
		}
	});

	router.post("/join", validateBody(JoinTeamSchema), async (req, res, next) => {
		try {
			const login = res.locals.login;
			if (login === undefined) {
				res.status(401).json({ error: "Sign in required" });
				return;
			}
			const { token } = req.body as z.infer<typeof JoinTeamSchema>;
			const payload = verifyInvite(token, sessionSecret);
			if (payload === undefined) {
				res.status(400).json({ error: "This invite link is invalid or has expired" });
				return;
			}
			const team = await teamStore.loadTeam(payload.teamId);
			if (team === undefined) {
				res.status(404).json({ error: "This team no longer exists" });
				return;
			}

			// A revoked invite's token still verifies (the signature alone can't know about a
			// later revocation) — the persisted record is the only place that can be checked.
			// A missing record (predates this feature, or the team's invites.json was reset)
			// is not treated as revoked: the token's own signature is still sufficient proof.
			const inviteRecord = await teamStore.getInvite(payload.teamId, payload.id);
			if (inviteRecord?.revokedAt !== undefined) {
				res.status(400).json({ error: "This invite has been revoked" });
				return;
			}

			const existingMembership = await teamStore.getMembership(payload.teamId, login);
			if (existingMembership === undefined) {
				await teamStore.addMember(payload.teamId, {
					login,
					teamId: payload.teamId,
					role: payload.role,
					joinedAt: new Date().toISOString(),
				});
			}

			await teamStore.updateMembershipIndex(login, (current) => ({
				teamIds: [...new Set([...(current?.teamIds ?? []), payload.teamId])],
				activeTeamId: payload.teamId,
			}));
			await teamStore.markInviteRedeemed(payload.teamId, payload.id, login);

			// Best-effort, never awaited into the response — see syncCollaboratorAdd. Uses the
			// login's actual current role, not payload.role: invites are reusable (nothing
			// checks redeemedAt on redemption, only revokedAt), so a still-valid higher-role
			// invite re-redeemed by an existing lower-role member must not grant them a GitHub
			// permission above what Quire itself records for them.
			syncCollaboratorAdd(payload.teamId, login, existingMembership?.role ?? payload.role);

			res.json({ teamId: payload.teamId, name: team.name });
		} catch (err) {
			next(err);
		}
	});

	router.post("/leave", validateBody(LeaveTeamSchema), async (req, res, next) => {
		try {
			const login = res.locals.login;
			if (login === undefined) {
				res.status(401).json({ error: "Sign in required" });
				return;
			}
			const { teamId } = req.body as z.infer<typeof LeaveTeamSchema>;
			const index = await teamStore.loadMembershipIndex(login);
			if (index === undefined || !index.teamIds.includes(teamId)) {
				res.status(400).json({ error: "You are not a member of that team" });
				return;
			}

			try {
				await teamStore.removeMember(teamId, login);
			} catch (err) {
				if (err instanceof LastOwnerError) {
					res.status(409).json({ error: "You're the only owner — promote someone else first, or remove the team's other members" });
					return;
				}
				throw err;
			}

			// Never leave a login with zero teams — releaseLoginFromTeam auto-provisions a
			// fresh personal team if this was its last one, mirroring resolveActiveMembership's
			// own first-login behavior. Shared with an owner/admin removing someone else (see
			// routes in the roles PR) so both go through one "never teamless" guarantee.
			const updated = await teamStore.releaseLoginFromTeam(login, teamId);

			syncCollaboratorRemove(teamId, login);

			res.json({ activeTeamId: updated.activeTeamId });
		} catch (err) {
			next(err);
		}
	});

	// An admin can shuffle member <-> admin freely, but only an owner may grant or revoke
	// the owner role itself — checked here, not by requireRole alone, since it depends on
	// the target's *current* role as well as the requested one. The "does this leave the
	// team with zero owners" invariant itself lives in TeamStore.setMemberRole (enforced
	// atomically under its per-team lock, so two concurrent role changes can't both slip
	// past a stale count) — this route only translates that into a 409.
	router.post("/members/:login/role", requireRole("owner", "admin"), validateBody(ChangeRoleSchema), async (req, res, next) => {
		try {
			const membership = res.locals.membership;
			const login = res.locals.login;
			if (membership === undefined || login === undefined) {
				res.status(401).json({ error: "Sign in required" });
				return;
			}
			const targetLogin = req.params["login"] ?? "";
			if (targetLogin === login) {
				res.status(400).json({ error: "You can't change your own role this way" });
				return;
			}
			const { role: newRole } = req.body as z.infer<typeof ChangeRoleSchema>;

			const target = await teamStore.getMembership(membership.teamId, targetLogin);
			if (target === undefined) {
				res.status(404).json({ error: "That login is not a member of this team" });
				return;
			}

			const touchesOwnerRole = target.role === "owner" || newRole === "owner";
			if (touchesOwnerRole && membership.role !== "owner") {
				res.status(403).json({ error: "Only an owner can grant or revoke the owner role" });
				return;
			}

			try {
				await teamStore.setMemberRole(membership.teamId, targetLogin, newRole);
			} catch (err) {
				if (err instanceof LastOwnerError) {
					res.status(409).json({ error: "A team must always have at least one owner" });
					return;
				}
				throw err;
			}
			res.json({ login: targetLogin, role: newRole });
		} catch (err) {
			next(err);
		}
	});

	// Removing a login from the team never leaves it teamless — releaseLoginFromTeam is the
	// same helper /leave uses for a login removing itself, applied here to someone else's
	// membership index. The "does this leave the team with zero owners" invariant lives in
	// TeamStore.removeMember (enforced atomically under its per-team lock) — this route only
	// translates that into a 409.
	router.post("/members/:login/remove", requireRole("owner", "admin"), async (req, res, next) => {
		try {
			const membership = res.locals.membership;
			const login = res.locals.login;
			if (membership === undefined || login === undefined) {
				res.status(401).json({ error: "Sign in required" });
				return;
			}
			const targetLogin = req.params["login"] ?? "";
			if (targetLogin === login) {
				res.status(400).json({ error: "You can't remove yourself this way — use Leave team instead" });
				return;
			}

			const target = await teamStore.getMembership(membership.teamId, targetLogin);
			if (target === undefined) {
				res.status(404).json({ error: "That login is not a member of this team" });
				return;
			}
			if (target.role === "owner" && membership.role !== "owner") {
				res.status(403).json({ error: "Only an owner can remove another owner" });
				return;
			}

			try {
				await teamStore.removeMember(membership.teamId, targetLogin);
			} catch (err) {
				if (err instanceof LastOwnerError) {
					res.status(409).json({ error: "A team must always have at least one owner" });
					return;
				}
				throw err;
			}

			await teamStore.releaseLoginFromTeam(targetLogin, membership.teamId);

			syncCollaboratorRemove(membership.teamId, targetLogin);

			res.json({ login: targetLogin, removed: true });
		} catch (err) {
			next(err);
		}
	});

	return router;
}
