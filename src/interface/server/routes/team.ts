import { Router } from "express";
import { z } from "zod";
import type { TeamStore } from "../../../engine/team/teamStore.js";
import { LastOwnerError, NotAMemberError } from "../../../engine/team/teamStore.js";
import { createInvite, verifyInvite } from "../invite.js";
import { validateBody } from "../middleware/validation.js";
import { requireRole } from "../middleware/requireRole.js";

const CreateTeamSchema = z.object({ name: z.string().min(1) });
const RenameTeamSchema = z.object({ name: z.string().min(1) });
const SwitchTeamSchema = z.object({ teamId: z.string().min(1) });
const JoinTeamSchema = z.object({ token: z.string().min(1) });
const LeaveTeamSchema = z.object({ teamId: z.string().min(1) });
const ChangeRoleSchema = z.object({ role: z.enum(["owner", "admin", "member"]) });

// Mounted right after resolveMembership and before resolveTenant (see index.ts) —
// unlike githubAppRouter/llmAccountRouter, nothing here touches a TenantContext (GitHub
// client, merge queue, ...), only the login-level membership index and the team roster,
// so there's no reason to pay for resolving/loading a tenant just to manage team
// membership.
export function teamRouter(teamStore: TeamStore, sessionSecret: string, publicUrl: string): Router {
	const router = Router();

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

	router.post("/invite", requireRole("owner", "admin"), async (_req, res, next) => {
		try {
			const membership = res.locals.membership;
			const login = res.locals.login;
			if (membership === undefined || login === undefined) {
				res.status(401).json({ error: "Sign in required" });
				return;
			}
			const token = createInvite(membership.teamId, login, sessionSecret);
			res.json({ inviteUrl: `${publicUrl}/?joinTeam=${token}` });
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

			const existingMembership = await teamStore.getMembership(payload.teamId, login);
			if (existingMembership === undefined) {
				await teamStore.addMember(payload.teamId, {
					login,
					teamId: payload.teamId,
					role: "member",
					joinedAt: new Date().toISOString(),
				});
			}

			await teamStore.updateMembershipIndex(login, (current) => ({
				teamIds: [...new Set([...(current?.teamIds ?? []), payload.teamId])],
				activeTeamId: payload.teamId,
			}));
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
			res.json({ activeTeamId: updated.activeTeamId });
		} catch (err) {
			next(err);
		}
	});

	// An admin can shuffle member <-> admin freely, but only an owner may grant or revoke
	// the owner role itself — checked here, not by requireRole alone, since it depends on
	// the target's *current* role as well as the requested one. Combined with the
	// last-owner guard below, a team can never end up with zero owners through this route.
	router.post("/members/:login/role", requireRole("owner", "admin"), validateBody(ChangeRoleSchema), async (req, res, next) => {
		try {
			const membership = res.locals.membership;
			if (membership === undefined) {
				res.status(401).json({ error: "Sign in required" });
				return;
			}
			const targetLogin = req.params["login"] ?? "";
			const { role: newRole } = req.body as z.infer<typeof ChangeRoleSchema>;

			const members = await teamStore.listMembers(membership.teamId);
			const target = members.find((m) => m.login === targetLogin);
			if (target === undefined) {
				res.status(404).json({ error: "That login is not a member of this team" });
				return;
			}

			const touchesOwnerRole = target.role === "owner" || newRole === "owner";
			if (touchesOwnerRole && membership.role !== "owner") {
				res.status(403).json({ error: "Only an owner can grant or revoke the owner role" });
				return;
			}
			if (target.role === "owner" && newRole !== "owner" && members.filter((m) => m.role === "owner").length <= 1) {
				res.status(409).json({ error: "A team must always have at least one owner" });
				return;
			}

			await teamStore.setMemberRole(membership.teamId, targetLogin, newRole);
			res.json({ login: targetLogin, role: newRole });
		} catch (err) {
			next(err);
		}
	});

	// Removing a login from the team never leaves it teamless — mirrors /leave's own
	// "never zero teams" guarantee, just applied to someone else's membership index.
	router.post("/members/:login/remove", requireRole("owner", "admin"), async (req, res, next) => {
		try {
			const membership = res.locals.membership;
			if (membership === undefined) {
				res.status(401).json({ error: "Sign in required" });
				return;
			}
			const targetLogin = req.params["login"] ?? "";

			const members = await teamStore.listMembers(membership.teamId);
			const target = members.find((m) => m.login === targetLogin);
			if (target === undefined) {
				res.status(404).json({ error: "That login is not a member of this team" });
				return;
			}
			if (target.role === "owner" && membership.role !== "owner") {
				res.status(403).json({ error: "Only an owner can remove another owner" });
				return;
			}
			if (target.role === "owner" && members.filter((m) => m.role === "owner").length <= 1) {
				res.status(409).json({ error: "A team must always have at least one owner" });
				return;
			}

			await teamStore.removeMember(membership.teamId, targetLogin);

			const targetIndex = await teamStore.loadMembershipIndex(targetLogin);
			if (targetIndex !== undefined) {
				const remainingTeamIds = targetIndex.teamIds.filter((id) => id !== membership.teamId);
				if (remainingTeamIds.length === 0) {
					await teamStore.createTeamForLogin(targetLogin, `${targetLogin}'s team`);
				} else {
					const activeTeamId =
						targetIndex.activeTeamId === membership.teamId
							? (remainingTeamIds[0] ?? targetIndex.activeTeamId)
							: targetIndex.activeTeamId;
					await teamStore.saveMembershipIndex(targetLogin, { teamIds: remainingTeamIds, activeTeamId });
				}
			}

			res.json({ login: targetLogin, removed: true });
		} catch (err) {
			next(err);
		}
	});

	return router;
}
