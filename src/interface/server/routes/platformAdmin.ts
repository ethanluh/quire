import { Router } from "express";
import type { TenantRegistry } from "../tenant.js";
import type { TeamStore } from "../../../engine/team/teamStore.js";
import type { Allowlist } from "../allowlist.js";
import { requirePlatformAdmin } from "../middleware/requirePlatformAdmin.js";

// Read-only for now (Phase 1 — see the admin console plan): visibility across every team
// registered with this process, for the person operating Quire itself, not any one team's
// owner/admin. Write paths (access-control editing, platform-wide gate defaults) are a
// separate, higher-blast-radius follow-up.
export function platformAdminRouter(registry: TenantRegistry, teamStore: TeamStore, allowlist: Allowlist): Router {
	const router = Router();
	router.use(requirePlatformAdmin(allowlist));

	router.get("/teams", async (_req, res, next) => {
		try {
			const teams = await Promise.all(
				registry.all().map(async (tenant) => {
					const [team, members, queueEntries] = await Promise.all([
						teamStore.loadTeam(tenant.teamId),
						teamStore.listMembers(tenant.teamId),
						tenant.queue.listEntries(),
					]);
					return {
						teamId: tenant.teamId,
						name: team?.name ?? tenant.teamId,
						memberCount: members.length,
						installationCount: tenant.accountState.current.installations.length,
						watchedRepoCount: tenant.accountState.current.repos.length,
						activeQueueCount: queueEntries.filter((e) => e.status !== "landed" && e.status !== "closed").length,
					};
				}),
			);
			res.json({ teams });
		} catch (err) {
			next(err);
		}
	});

	router.get("/teams/:teamId", async (req, res, next) => {
		try {
			const teamId = req.params["teamId"] ?? "";
			const tenant = registry.all().find((t) => t.teamId === teamId);
			if (tenant === undefined) {
				res.status(404).json({ error: "Team not found" });
				return;
			}
			const [team, members, queueEntries] = await Promise.all([
				teamStore.loadTeam(teamId),
				teamStore.listMembers(teamId),
				tenant.queue.listEntries(),
			]);
			res.json({
				teamId,
				name: team?.name ?? teamId,
				createdAt: team?.createdAt,
				members,
				installations: tenant.accountState.current.installations,
				repos: tenant.accountState.current.repos,
				queueEntries,
				recentAudit: tenant.auditStore.list().slice(-50),
			});
		} catch (err) {
			next(err);
		}
	});

	// Aggregates every tenant's own AuditStore and tags each entry with its teamId —
	// AuditStore itself has no notion of teamId (isolation today is purely structural, one
	// instance per tenant), so that tagging has to happen here, not inside the store.
	router.get("/audit", (_req, res) => {
		const entries = registry
			.all()
			.flatMap((tenant) => tenant.auditStore.list().map((entry) => ({ ...entry, teamId: tenant.teamId })))
			.sort((a, b) => (a.addedAt < b.addedAt ? 1 : -1));
		res.json({ entries });
	});

	return router;
}
