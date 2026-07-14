import { describe, it, expect, afterEach } from "@jest/globals";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import type { Server } from "node:http";
import { adminRouter } from "../../src/interface/server/routes/admin.js";
import type { TeamRole } from "../../src/engine/types/team.js";

function stubMembership(role: TeamRole) {
	return (_req: Request, res: Response, next: NextFunction) => {
		res.locals.membership = { teamId: "test-team", role };
		next();
	};
}
import { createServerState } from "../../src/interface/server/state.js";
import { AuditStore } from "../../src/engine/gate/auditStore.js";
import { MergeQueue } from "../../src/engine/queue/mergeQueue.js";
import { StubGitHubClient } from "../../src/engine/github/stubClient.js";
import { StubLlmProvider } from "../../src/engine/drift/effectList/stubProvider.js";
import { LlmProviderHolder } from "../../src/engine/drift/effectList/providerHolder.js";
import { DecidedPrStore } from "../../src/engine/queue/decidedPrStore.js";
import type { PullRequest, Bundle, ReviewCard } from "../../src/engine/types/core.js";
import type { AdminGateConfigDeps } from "../../src/interface/server/routes/admin.js";

function stubGateConfigDeps(): AdminGateConfigDeps {
	let override: { criteria: ReadonlyArray<{ name: string; mode: "enforce" | "shadow" | "off" }> } | undefined;
	return {
		store: {
			get: () => override,
			set: async (next) => {
				override = next;
			},
		} as AdminGateConfigDeps["store"],
		platformDefault: [],
		onChange: () => {},
	};
}

function makePR(): PullRequest {
	return {
		id: "pr-1",
		repoOwner: "org",
		repoName: "repo",
		number: 1,
		headSha: "sha-1",
		declaredDirection: "add passwordless auth",
		directionInferred: false,
		diff: { raw: "", hunks: [] },
		filesTouched: ["src/auth.ts"],
		symbolsTouched: [],
		testNamesChanged: [],
		ciStatus: "success",
	};
}

function makeCard(bundleId: string): ReviewCard {
	return {
		bundleId,
		directionSummary: "add passwordless auth",
		directionInferred: false,
		repoOwner: "org",
		repoName: "repo",
		blastRadius: 1,
		flags: [],
		drift: { status: "clean" },
		residualDisclosure: "behavioral confirm not run",
		specConformance: { status: "clean" },
		specConformanceDisclosure: "",
		inputsHash: "hash-1",
		memberCount: 0,
		requiresAcceptConfirmation: false,
	};
}

function makeBundle(id: string): Bundle {
	return { id, direction: "add passwordless auth", directionInferred: false, effectSummary: "adds OTP-based login", members: [] };
}

async function postReset(server: Server): Promise<{ status: number; body: { status?: string; error?: string } }> {
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("no address");
	const res = await fetch(`http://127.0.0.1:${address.port}/admin/reset`, { method: "POST" });
	return { status: res.status, body: (await res.json()) as { status?: string; error?: string } };
}

describe("adminRouter POST /reset", () => {
	let dir: string;
	let server: Server;

	afterEach(async () => {
		if (server) await new Promise((resolve) => server.close(resolve));
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	it("clears bundles, cards, shelf, audit entries, the merge queue, and all instrumentation logs", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-admin-"));
		const queuePath = join(dir, "queue.json");
		const deferLogPath = join(dir, "instrumentation", "defers.ndjson");
		const gateLogPath = join(dir, "instrumentation", "gate-decisions.ndjson");
		const driftScreenLogPath = join(dir, "instrumentation", "drift-screen.ndjson");
		await mkdir(dirname(deferLogPath), { recursive: true });
		await writeFile(deferLogPath, '{"bundleId":"b-1"}\n', "utf8");
		await writeFile(gateLogPath, '{"prId":"pr-1"}\n', "utf8");
		await writeFile(driftScreenLogPath, '{"prId":"pr-1"}\n', "utf8");

		const state = createServerState();
		state.bundles.set("b-1", makeBundle("b-1"));
		state.cards.set("b-1", makeCard("b-1"));
		state.shelf.set("b-2", { card: makeCard("b-2"), memberPrIds: [] });

		const auditStore = new AuditStore();
		await auditStore.add(makePR(), "duplicate", "looks like a dup");

		const queue = new MergeQueue(queuePath, new StubGitHubClient(), new LlmProviderHolder(new StubLlmProvider()), join(dir, "conflict.ndjson"));
		await queue.load();
		await queue.enqueue(makeBundle("b-3"));

		const decidedStore = new DecidedPrStore(join(dir, "decided-prs.json"));
		await decidedStore.markDecided(["pr-1"], "reject", { decidedBy: "tester", bundleId: "test-bundle" });

		const app = express();
		app.use(stubMembership("owner"));
		app.use(
			"/admin",
			adminRouter(
				state,
				auditStore,
				queue,
				[deferLogPath, gateLogPath, driftScreenLogPath],
				decidedStore,
				join(dir, "shelf.json"),
				stubGateConfigDeps(),
			),
		);
		server = app.listen(0);
		await new Promise((resolve) => server.once("listening", resolve));

		const { status, body } = await postReset(server);

		expect(status).toBe(200);
		expect(body.status).toBe("reset");
		expect(state.bundles.size).toBe(0);
		expect(state.cards.size).toBe(0);
		expect(state.shelf.size).toBe(0);
		expect(auditStore.list()).toHaveLength(0);
		expect(await queue.listEntries()).toHaveLength(0);
		expect(decidedStore.isDecided("pr-1")).toBe(false);
		expect(await readFile(deferLogPath, "utf8")).toBe("");
		expect(await readFile(gateLogPath, "utf8")).toBe("");
		expect(await readFile(driftScreenLogPath, "utf8")).toBe("");
	});

	it.each<TeamRole>(["admin", "member"])("rejects %s with 403", async (role) => {
		dir = await mkdtemp(join(tmpdir(), "quire-admin-"));
		const state = createServerState();
		const auditStore = new AuditStore();
		const queue = new MergeQueue(join(dir, "queue.json"), new StubGitHubClient(), new LlmProviderHolder(new StubLlmProvider()), join(dir, "conflict.ndjson"));
		await queue.load();
		const decidedStore = new DecidedPrStore(join(dir, "decided-prs.json"));

		const app = express();
		app.use(stubMembership(role));
		app.use("/admin", adminRouter(state, auditStore, queue, [], decidedStore, join(dir, "shelf.json"), stubGateConfigDeps()));
		server = app.listen(0);
		await new Promise((resolve) => server.once("listening", resolve));

		const { status } = await postReset(server);
		expect(status).toBe(403);
	});
});

describe("adminRouter gate-config routes", () => {
	let dir: string;
	let server: Server;

	afterEach(async () => {
		if (server) await new Promise((resolve) => server.close(resolve));
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	async function startApp(role: TeamRole, gateConfig: AdminGateConfigDeps): Promise<Server> {
		dir = await mkdtemp(join(tmpdir(), "quire-admin-gate-"));
		const state = createServerState();
		const auditStore = new AuditStore();
		const queue = new MergeQueue(join(dir, "queue.json"), new StubGitHubClient(), new LlmProviderHolder(new StubLlmProvider()), join(dir, "conflict.ndjson"));
		await queue.load();
		const decidedStore = new DecidedPrStore(join(dir, "decided-prs.json"));

		const app = express();
		app.use(express.json());
		app.use(stubMembership(role));
		app.use("/admin", adminRouter(state, auditStore, queue, [], decidedStore, join(dir, "shelf.json"), gateConfig));
		const srv = app.listen(0);
		await new Promise((resolve) => srv.once("listening", resolve));
		return srv;
	}

	function address(srv: Server) {
		const addr = srv.address();
		if (addr === null || typeof addr === "string") throw new Error("no address");
		return `http://127.0.0.1:${addr.port}`;
	}

	it("GET reflects the platform default when no override has been saved", async () => {
		const deps = stubGateConfigDeps();
		deps.platformDefault = [{ name: "buildFailure", mode: "enforce" }, { name: "duplicate", mode: "shadow" }] as AdminGateConfigDeps["platformDefault"];
		server = await startApp("admin", deps);
		const res = await fetch(`${address(server)}/admin/gate-config`);
		const body = (await res.json()) as { effective: unknown; override: unknown };
		expect(res.status).toBe(200);
		expect(body.effective).toEqual(deps.platformDefault);
		expect(body.override).toBeNull();
	});

	it("PATCH persists an override, calls onChange, and GET reflects it afterward", async () => {
		let changed = 0;
		const deps = stubGateConfigDeps();
		deps.platformDefault = [{ name: "buildFailure", mode: "enforce" }, { name: "duplicate", mode: "shadow" }] as AdminGateConfigDeps["platformDefault"];
		deps.onChange = () => {
			changed++;
		};
		server = await startApp("owner", deps);

		const patchRes = await fetch(`${address(server)}/admin/gate-config`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ criteria: [{ name: "duplicate", mode: "off" }] }),
		});
		expect(patchRes.status).toBe(200);
		expect(changed).toBe(1);

		const getRes = await fetch(`${address(server)}/admin/gate-config`);
		const body = (await getRes.json()) as { effective: Array<{ name: string; mode: string }> };
		expect(body.effective).toEqual([
			{ name: "buildFailure", mode: "enforce" },
			{ name: "duplicate", mode: "off" },
		]);
	});

	it("PATCH rejects an unknown criterion name", async () => {
		server = await startApp("owner", stubGateConfigDeps());
		const res = await fetch(`${address(server)}/admin/gate-config`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ criteria: [{ name: "notARealCriterion", mode: "off" }] }),
		});
		expect(res.status).toBe(400);
	});

	it("PATCH rejects an unknown mode", async () => {
		server = await startApp("owner", stubGateConfigDeps());
		const res = await fetch(`${address(server)}/admin/gate-config`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ criteria: [{ name: "duplicate", mode: "silently-ignore" }] }),
		});
		expect(res.status).toBe(400);
	});

	it.each<TeamRole>(["member"])("rejects %s with 403 on PATCH", async (role) => {
		server = await startApp(role, stubGateConfigDeps());
		const res = await fetch(`${address(server)}/admin/gate-config`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ criteria: [] }),
		});
		expect(res.status).toBe(403);
	});
});
