import { describe, it, expect, afterEach } from "@jest/globals";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response, NextFunction } from "express";
import { resolveMembership } from "../../src/interface/server/middleware/resolveMembership.js";
import { TeamStore } from "../../src/engine/team/teamStore.js";

function makeRes(login: string | undefined): Response {
	const res: Partial<Response> = {};
	res.locals = login === undefined ? {} : { login };
	res.status = ((code: number) => {
		res.statusCode = code;
		return res;
	}) as unknown as Response["status"];
	res.json = (() => res) as unknown as Response["json"];
	return res as Response;
}

describe("resolveMembership", () => {
	let dir: string;
	let store: TeamStore;

	afterEach(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	// The middleware under test does its work in an unawaited async IIFE, so a call to it
	// returns before next()/res.status() actually run — wait on whichever fires first
	// instead of guessing how many microtask/IO ticks it needs.
	async function run(res: Response): Promise<{ calledNext: boolean }> {
		return new Promise((resolve) => {
			const next = (() => resolve({ calledNext: true })) as unknown as NextFunction;
			const originalStatus = res.status;
			res.status = ((code: number) => {
				const result = originalStatus.call(res, code);
				resolve({ calledNext: false });
				return result;
			}) as unknown as Response["status"];
			resolveMembership(store)({} as Request, res, next);
		});
	}

	it("rejects with 401 when there is no login on res.locals", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-resolvemembership-"));
		store = new TeamStore(dir);
		const res = makeRes(undefined);

		const { calledNext } = await run(res);

		expect(calledNext).toBe(false);
		expect(res.statusCode).toBe(401);
	});

	it("auto-provisions a personal team of one on a login's first request", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-resolvemembership-"));
		store = new TeamStore(dir);
		const res = makeRes("alice");

		const { calledNext } = await run(res);

		expect(calledNext).toBe(true);
		expect(res.locals.membership?.role).toBe("owner");
		const teamId = res.locals.membership?.teamId as string;
		const team = await store.loadTeam(teamId);
		expect(team?.createdBy).toBe("alice");
	});

	it("reuses the same team on a login's second request instead of provisioning another", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-resolvemembership-"));
		store = new TeamStore(dir);

		const firstRes = makeRes("alice");
		await run(firstRes);

		const secondRes = makeRes("alice");
		await run(secondRes);

		expect(secondRes.locals.membership?.teamId).toBe(firstRes.locals.membership?.teamId);
	});

	it("resolves to the login's active team, not necessarily its first/only one", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-resolvemembership-"));
		store = new TeamStore(dir);
		await store.createTeamForLogin("alice", "First");
		const second = await store.createTeamForLogin("alice", "Second", { keepExistingTeams: true });

		const res = makeRes("alice");
		await run(res);

		expect(res.locals.membership?.teamId).toBe(second.teamId);
	});

	it("gives two different logins independent teams", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-resolvemembership-"));
		store = new TeamStore(dir);

		const aliceRes = makeRes("alice");
		await run(aliceRes);

		const bobRes = makeRes("bob");
		await run(bobRes);

		expect(aliceRes.locals.membership?.teamId).not.toBe(bobRes.locals.membership?.teamId);
	});
});
