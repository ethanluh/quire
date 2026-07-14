import { Router } from "express";
import type { TenantRegistry } from "../tenant.js";
import type { TeamStore } from "../../../engine/team/teamStore.js";
import type { Allowlist } from "../allowlist.js";
import { requirePlatformAdmin } from "../middleware/requirePlatformAdmin.js";
import type { PlatformAllowlistStore } from "../../../engine/platform/platformAllowlistStore.js";
import type { PlatformGateDefaultsStore } from "../../../engine/platform/platformGateDefaultsStore.js";
import { logPlatformAdminAction } from "../../../engine/platform/adminActionLog.js";
import type { GateCriterion, GateMode } from "../../../engine/types/gate.js";
import { GATE_CRITERION_NAMES } from "../../../engine/gate/gate.js";

const KNOWN_CRITERIA_NAMES: ReadonlySet<string> = new Set(GATE_CRITERION_NAMES);
const KNOWN_MODES: ReadonlySet<GateMode> = new Set(["enforce", "shadow", "off"]);

function isValidCriterionBody(value: unknown): value is GateCriterion {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return typeof record["name"] === "string" && KNOWN_CRITERIA_NAMES.has(record["name"]) && KNOWN_MODES.has(record["mode"] as GateMode);
}

export interface PlatformAdminWriteDeps {
	// The raw, env-var-only allowlist (never OR'd with the supplemental store) — used solely
	// to check "would this login still be reachable without the supplemental list", so a
	// PATCH /access-control can never lock every platform admin out of the console at once.
	envAllowlist: Allowlist;
	// Whether QUIRE_PLATFORM_ADMIN_LOGINS is actually set to something (not just what
	// envAllowlist.allowsAll reports — createPlatformAdminAllowlist reports allowsAll:false
	// for BOTH "unconfigured" and "a real login list", so that flag alone can't tell them
	// apart; this is purely informational, shown by the console so an operator relying only
	// on the supplemental list below knows the env-var floor isn't set).
	envConfigured: boolean;
	allowlistStore: PlatformAllowlistStore;
	gateDefaultsStore: PlatformGateDefaultsStore;
	// Persists the new platform-wide default AND propagates it to every already-loaded
	// tenant's live PipelineDeps (see index.ts) — a plain gateDefaultsStore.set() alone
	// would only take effect for tenants that cold-start after this call.
	applyGateDefaults: (criteria: ReadonlyArray<GateCriterion>) => Promise<void>;
	adminActionLogPath: string;
}

// Read-only routes (team list/detail, cross-team audit feed) were Phase 1; this adds the
// write paths (access-control editing, platform-wide gate defaults) — higher blast radius,
// so every mutation here is logged to its own admin-actions.ndjson (see adminActionLog.ts),
// independent of any team's own per-tenant audit log.
export function platformAdminRouter(registry: TenantRegistry, teamStore: TeamStore, allowlist: Allowlist, writeDeps: PlatformAdminWriteDeps): Router {
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

	router.get("/access-control", (_req, res) => {
		res.json({
			envConfigured: writeDeps.envConfigured,
			supplemental: writeDeps.allowlistStore.get(),
		});
	});

	// Adds/removes logins from the persisted supplemental list only — QUIRE_PLATFORM_ADMIN_LOGINS
	// itself is never touched here (env vars aren't writable at runtime, and per
	// createPlatformAdminAllowlist's fail-closed default, that's the floor this can't erode).
	// Refuses a save that would leave the requesting actor with no way back in, mirroring
	// teamStore.ts's LastOwnerError guard for the same class of self-lockout mistake.
	router.patch("/access-control", async (req, res, next) => {
		try {
			const logins: unknown = (req.body as { logins?: unknown } | undefined)?.logins;
			if (!Array.isArray(logins) || !logins.every((l) => typeof l === "string")) {
				res.status(400).json({ error: "Body must be { logins: string[] }" });
				return;
			}
			const normalized = [...new Set(logins.map((l) => l.trim().toLowerCase()).filter((l) => l.length > 0))];
			const actor = res.locals.login ?? "";
			const actorStillReachable = writeDeps.envAllowlist.isAllowed(actor) || normalized.includes(actor.toLowerCase());
			if (!actorStillReachable) {
				res.status(400).json({
					error: "This would remove your own access to the platform admin console. Add your own login back before saving.",
				});
				return;
			}
			await writeDeps.allowlistStore.set(normalized);
			await logPlatformAdminAction(writeDeps.adminActionLogPath, actor, "access-control.set", { logins: normalized });
			res.json({ status: "saved", supplemental: writeDeps.allowlistStore.get() });
		} catch (err) {
			next(err);
		}
	});

	router.get("/gate-config", (_req, res) => {
		res.json({ criteria: writeDeps.gateDefaultsStore.get() ?? [] });
	});

	// Changes what every team inherits by default (see gateConfigStore.ts's
	// resolveEffectiveGateConfig) — a team with its own override is unaffected until it
	// clears that override.
	router.patch("/gate-config", async (req, res, next) => {
		try {
			const criteria: unknown = (req.body as { criteria?: unknown } | undefined)?.criteria;
			if (!Array.isArray(criteria) || criteria.length === 0 || !criteria.every(isValidCriterionBody)) {
				res.status(400).json({
					error: `Body must be non-empty { criteria: [{ name, mode }] } with name one of ${[...KNOWN_CRITERIA_NAMES].join(", ")} and mode one of ${[...KNOWN_MODES].join(", ")}`,
				});
				return;
			}
			await writeDeps.applyGateDefaults(criteria);
			await logPlatformAdminAction(writeDeps.adminActionLogPath, res.locals.login ?? "", "gate-config.set", { criteria });
			res.json({ status: "saved", criteria: writeDeps.gateDefaultsStore.get() });
		} catch (err) {
			next(err);
		}
	});

	return router;
}
