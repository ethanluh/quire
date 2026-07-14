import { describe, it, expect, afterEach } from "@jest/globals";
import express from "express";
import type { Server } from "node:http";
import { platformAdminRouter } from "../../src/interface/server/routes/platformAdmin.js";
import { createAllowlist } from "../../src/interface/server/allowlist.js";
import type { TenantRegistry, TenantContext } from "../../src/interface/server/tenant.js";
import type { TeamStore } from "../../src/engine/team/teamStore.js";
import type { PlatformAllowlistStore } from "../../src/engine/platform/platformAllowlistStore.js";
import type { PlatformGateDefaultsStore } from "../../src/engine/platform/platformGateDefaultsStore.js";
import type { GateCriterion } from "../../src/engine/types/gate.js";

function fakeTenant(teamId: string, refreshGateConfig: () => void = () => {}): TenantContext {
	return {
		teamId,
		accountState: { current: { installations: [], repos: [] } },
		auditStore: { list: () => [] } as unknown as TenantContext["auditStore"],
		queue: { listEntries: async () => [] } as unknown as TenantContext["queue"],
		refreshGateConfig,
	} as unknown as TenantContext;
}

function fakeRegistry(tenants: ReadonlyArray<TenantContext>): TenantRegistry {
	return { all: () => tenants } as unknown as TenantRegistry;
}

function fakeTeamStore(): TeamStore {
	return {
		loadTeam: async (teamId: string) => ({ teamId, name: `Team ${teamId}`, createdAt: "2026-01-01T00:00:00.000Z", createdBy: "x" }),
		listMembers: async () => [],
	} as unknown as TeamStore;
}

function fakeAllowlistStore(initial: ReadonlyArray<string> = []): PlatformAllowlistStore {
	let logins: ReadonlyArray<string> = initial;
	return {
		get: () => logins,
		set: async (next: ReadonlyArray<string>) => {
			logins = [...new Set(next.map((l) => l.trim().toLowerCase()).filter((l) => l.length > 0))];
		},
	} as unknown as PlatformAllowlistStore;
}

function fakeGateDefaultsStore(initial?: ReadonlyArray<GateCriterion>): PlatformGateDefaultsStore {
	let criteria = initial;
	return {
		get: () => criteria,
		set: async (next: ReadonlyArray<GateCriterion>) => {
			criteria = next;
		},
	} as unknown as PlatformGateDefaultsStore;
}

async function start(app: express.Express): Promise<Server> {
	const server = app.listen(0);
	await new Promise((resolve) => server.once("listening", resolve));
	return server;
}

function address(server: Server): string {
	const addr = server.address();
	if (addr === null || typeof addr === "string") throw new Error("no address");
	return `http://127.0.0.1:${addr.port}`;
}

describe("platformAdminRouter", () => {
	let server: Server;

	afterEach(async () => {
		if (server) await new Promise((resolve) => server.close(resolve));
	});

	it("403s a login not on the (combined) allowlist", async () => {
		const app = express();
		app.use((_req, res, next) => {
			res.locals.login = "nobody";
			next();
		});
		app.use(
			"/platform-admin",
			platformAdminRouter(fakeRegistry([]), fakeTeamStore(), createAllowlist("alice"), {
				envAllowlist: createAllowlist("alice"),
				envConfigured: true,
				allowlistStore: fakeAllowlistStore(),
				gateDefaultsStore: fakeGateDefaultsStore(),
				applyGateDefaults: async () => {},
				adminActionLogPath: "/tmp/does-not-matter.ndjson",
			}),
		);
		server = await start(app);
		const res = await fetch(`${address(server)}/platform-admin/teams`);
		expect(res.status).toBe(403);
	});

	it("lists teams with summary counts", async () => {
		const app = express();
		app.use((_req, res, next) => {
			res.locals.login = "alice";
			next();
		});
		app.use(
			"/platform-admin",
			platformAdminRouter(fakeRegistry([fakeTenant("team-1")]), fakeTeamStore(), createAllowlist("alice"), {
				envAllowlist: createAllowlist("alice"),
				envConfigured: true,
				allowlistStore: fakeAllowlistStore(),
				gateDefaultsStore: fakeGateDefaultsStore(),
				applyGateDefaults: async () => {},
				adminActionLogPath: "/tmp/does-not-matter.ndjson",
			}),
		);
		server = await start(app);
		const res = await fetch(`${address(server)}/platform-admin/teams`);
		const body = (await res.json()) as { teams: Array<{ teamId: string; name: string }> };
		expect(res.status).toBe(200);
		expect(body.teams).toEqual([expect.objectContaining({ teamId: "team-1", name: "Team team-1" })]);
	});

	describe("access-control", () => {
		function buildApp(allowlistStore: PlatformAllowlistStore) {
			const app = express();
			app.use(express.json());
			app.use((_req, res, next) => {
				res.locals.login = "alice";
				next();
			});
			app.use(
				"/platform-admin",
				platformAdminRouter(fakeRegistry([]), fakeTeamStore(), createAllowlist("alice"), {
					envAllowlist: createAllowlist("alice"),
					envConfigured: true,
					allowlistStore,
					gateDefaultsStore: fakeGateDefaultsStore(),
					applyGateDefaults: async () => {},
					adminActionLogPath: "/tmp/does-not-matter.ndjson",
				}),
			);
			return app;
		}

		it("PATCH persists a normalized supplemental list", async () => {
			const store = fakeAllowlistStore();
			server = await start(buildApp(store));
			const res = await fetch(`${address(server)}/platform-admin/access-control`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ logins: [" Bob ", "BOB"] }),
			});
			expect(res.status).toBe(200);
			expect(store.get()).toEqual(["bob"]);
		});

		// The requesting actor ("alice") is on the env allowlist in this test, not the
		// supplemental one — removing her from the supplemental list is fine, she's still
		// reachable via the env floor. This is the "still reachable" branch, not a lockout.
		it("PATCH allows an actor already covered by the env allowlist to omit themselves from the supplemental list", async () => {
			const store = fakeAllowlistStore(["alice"]);
			server = await start(buildApp(store));
			const res = await fetch(`${address(server)}/platform-admin/access-control`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ logins: ["carol"] }),
			});
			expect(res.status).toBe(200);
		});

		it("PATCH rejects a body without a logins array", async () => {
			server = await start(buildApp(fakeAllowlistStore()));
			const res = await fetch(`${address(server)}/platform-admin/access-control`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			});
			expect(res.status).toBe(400);
		});

		// The actor here ("bob") is reachable only via the supplemental list (not the env
		// allowlist, which only covers "alice" in this test's deps) — a save that drops him
		// from it would lock him out of the console entirely, so it must be refused.
		it("PATCH refuses a save that would lock the requesting actor out entirely", async () => {
			const store = fakeAllowlistStore(["bob"]);
			const app = express();
			app.use(express.json());
			app.use((_req, res, next) => {
				res.locals.login = "bob";
				next();
			});
			app.use(
				"/platform-admin",
				platformAdminRouter(fakeRegistry([]), fakeTeamStore(), createAllowlist("alice,bob"), {
					envAllowlist: createAllowlist("alice"),
					envConfigured: true,
					allowlistStore: store,
					gateDefaultsStore: fakeGateDefaultsStore(),
					applyGateDefaults: async () => {},
					adminActionLogPath: "/tmp/does-not-matter.ndjson",
				}),
			);
			server = await start(app);
			const res = await fetch(`${address(server)}/platform-admin/access-control`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ logins: ["carol"] }),
			});
			expect(res.status).toBe(400);
			expect(store.get()).toEqual(["bob"]);
		});
	});

	describe("gate-config", () => {
		it("PATCH persists new defaults and calls applyGateDefaults + every tenant's refreshGateConfig", async () => {
			let applied: ReadonlyArray<GateCriterion> | undefined;
			let refreshed = 0;
			const tenant = fakeTenant("team-1", () => {
				refreshed++;
			});
			const app = express();
			app.use(express.json());
			app.use((_req, res, next) => {
				res.locals.login = "alice";
				next();
			});
			const gateDefaultsStore = fakeGateDefaultsStore();
			app.use(
				"/platform-admin",
				platformAdminRouter(fakeRegistry([tenant]), fakeTeamStore(), createAllowlist("alice"), {
					envAllowlist: createAllowlist("alice"),
					envConfigured: true,
					allowlistStore: fakeAllowlistStore(),
					gateDefaultsStore,
					applyGateDefaults: async (criteria) => {
						applied = criteria;
						await gateDefaultsStore.set(criteria);
						tenant.refreshGateConfig();
					},
					adminActionLogPath: "/tmp/does-not-matter.ndjson",
				}),
			);
			server = await start(app);

			const res = await fetch(`${address(server)}/platform-admin/gate-config`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ criteria: [{ name: "buildFailure", mode: "off" }] }),
			});
			expect(res.status).toBe(200);
			expect(applied).toEqual([{ name: "buildFailure", mode: "off" }]);
			expect(refreshed).toBe(1);
			expect(gateDefaultsStore.get()).toEqual([{ name: "buildFailure", mode: "off" }]);
		});

		it("PATCH rejects an empty criteria list", async () => {
			const app = express();
			app.use(express.json());
			app.use((_req, res, next) => {
				res.locals.login = "alice";
				next();
			});
			app.use(
				"/platform-admin",
				platformAdminRouter(fakeRegistry([]), fakeTeamStore(), createAllowlist("alice"), {
					envAllowlist: createAllowlist("alice"),
					envConfigured: true,
					allowlistStore: fakeAllowlistStore(),
					gateDefaultsStore: fakeGateDefaultsStore(),
					applyGateDefaults: async () => {},
					adminActionLogPath: "/tmp/does-not-matter.ndjson",
				}),
			);
			server = await start(app);
			const res = await fetch(`${address(server)}/platform-admin/gate-config`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ criteria: [] }),
			});
			expect(res.status).toBe(400);
		});

		it("PATCH rejects an unknown criterion name", async () => {
			const app = express();
			app.use(express.json());
			app.use((_req, res, next) => {
				res.locals.login = "alice";
				next();
			});
			app.use(
				"/platform-admin",
				platformAdminRouter(fakeRegistry([]), fakeTeamStore(), createAllowlist("alice"), {
					envAllowlist: createAllowlist("alice"),
					envConfigured: true,
					allowlistStore: fakeAllowlistStore(),
					gateDefaultsStore: fakeGateDefaultsStore(),
					applyGateDefaults: async () => {},
					adminActionLogPath: "/tmp/does-not-matter.ndjson",
				}),
			);
			server = await start(app);
			const res = await fetch(`${address(server)}/platform-admin/gate-config`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ criteria: [{ name: "notReal", mode: "off" }] }),
			});
			expect(res.status).toBe(400);
		});
	});
});
