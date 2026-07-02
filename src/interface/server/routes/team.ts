import { Router } from "express";
import { z } from "zod";
import type { TeamStore } from "../../../engine/team/teamStore.js";
import { LastOwnerError, NotAMemberError } from "../../../engine/team/teamStore.js";
import { createInvite, verifyInvite } from "../invite.js";
import { validateBody } from "../middleware/validation.js";

const CreateTeamSchema = z.object({ name: z.string().min(1) });
const RenameTeamSchema = z.object({ name: z.string().min(1) });
const SwitchTeamSchema = z.object({ teamId: z.string().min(1) });
const JoinTeamSchema = z.object({ token: z.string().min(1) });
const LeaveTeamSchema = z.object({ teamId: z.string().min(1) });

// Mounted right after resolveMembership and before resolveTenant (see index.ts) —
// unlike githubAppRouter/llmAccountRouter, nothing here touches a TenantContext (GitHub
// client, merge queue, ...), only the login-level membership index and the team roster,
// so there's no reason to pay for resolving/loading a tenant just to manage team
// membership. Deliberately self-service only: no member-removal or role-change route
// lands here — both need real role enforcement to be safe, which arrives in the
// follow-up PR that also activates TeamRole enforcement everywhere else.
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

	router.patch("/", validateBody(RenameTeamSchema), async (req, res, next) => {
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

	router.post("/invite", async (_req, res, next) => {
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

	return router;
}
