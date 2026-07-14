import { describe, it, expect, afterEach } from "@jest/globals";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import type { Server } from "node:http";
import { requirePlatformAdmin } from "../../src/interface/server/middleware/requirePlatformAdmin.js";
import { createPlatformAdminAllowlist } from "../../src/interface/server/allowlist.js";

function stubLogin(login?: string) {
	return (_req: Request, res: Response, next: NextFunction) => {
		if (login !== undefined) res.locals.login = login;
		next();
	};
}

async function get(server: Server, path: string): Promise<number> {
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("no address");
	const res = await fetch(`http://127.0.0.1:${address.port}${path}`);
	return res.status;
}

describe("requirePlatformAdmin", () => {
	let server: Server;

	afterEach(async () => {
		if (server) await new Promise((resolve) => server.close(resolve));
	});

	it("401s when no session (no login) is present", async () => {
		const app = express();
		app.use(stubLogin(undefined));
		app.use(requirePlatformAdmin(createPlatformAdminAllowlist("alice")));
		app.get("/platform-admin/teams", (_req, res) => res.json({ ok: true }));
		server = app.listen(0);
		await new Promise((resolve) => server.once("listening", resolve));
		expect(await get(server, "/platform-admin/teams")).toBe(401);
	});

	it("403s a signed-in login that isn't on the platform-admin allowlist", async () => {
		const app = express();
		app.use(stubLogin("bob"));
		app.use(requirePlatformAdmin(createPlatformAdminAllowlist("alice")));
		app.get("/platform-admin/teams", (_req, res) => res.json({ ok: true }));
		server = app.listen(0);
		await new Promise((resolve) => server.once("listening", resolve));
		expect(await get(server, "/platform-admin/teams")).toBe(403);
	});

	it("admits a login on the platform-admin allowlist", async () => {
		const app = express();
		app.use(stubLogin("alice"));
		app.use(requirePlatformAdmin(createPlatformAdminAllowlist("alice")));
		app.get("/platform-admin/teams", (_req, res) => res.json({ ok: true }));
		server = app.listen(0);
		await new Promise((resolve) => server.once("listening", resolve));
		expect(await get(server, "/platform-admin/teams")).toBe(200);
	});

	// A team's own owner/admin role must grant nothing here — this is a deliberately
	// separate, higher-privilege allowlist from requireRole's per-team check.
	it("denies everyone when QUIRE_PLATFORM_ADMIN_LOGINS is unconfigured", async () => {
		const app = express();
		app.use(stubLogin("alice"));
		app.use(requirePlatformAdmin(createPlatformAdminAllowlist(undefined)));
		app.get("/platform-admin/teams", (_req, res) => res.json({ ok: true }));
		server = app.listen(0);
		await new Promise((resolve) => server.once("listening", resolve));
		expect(await get(server, "/platform-admin/teams")).toBe(403);
	});
});
