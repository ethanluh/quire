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
import { StubLlmProvider } from "../mocks/llmProvider.js";
import { DecidedPrStore } from "../../src/engine/queue/decidedPrStore.js";
import type { PullRequest, Bundle, ReviewCard } from "../../src/engine/types/core.js";

function makePR(): PullRequest {
	return {
		id: "pr-1",
		repoOwner: "org",
		repoName: "repo",
		number: 1,
		headSha: "sha-1",
		declaredDirection: "add passwordless auth",
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
		blastRadius: 1,
		flags: [],
		drift: { status: "clean" },
		residualDisclosure: "behavioral confirm not run",
		inputsHash: "hash-1",
	};
}

function makeBundle(id: string): Bundle {
	return { id, direction: "add passwordless auth", effectSummary: "adds OTP-based login", members: [] };
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

		const queue = new MergeQueue(queuePath, new StubGitHubClient(), new StubLlmProvider(), join(dir, "conflict.ndjson"));
		await queue.load();
		await queue.enqueue(makeBundle("b-3"));

		const decidedStore = new DecidedPrStore(join(dir, "decided-prs.json"));
		await decidedStore.markDecided(["pr-1"], "reject");

		const app = express();
		app.use(stubMembership("owner"));
		app.use(
			"/admin",
			adminRouter(state, auditStore, queue, [deferLogPath, gateLogPath, driftScreenLogPath], decidedStore),
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
		const queue = new MergeQueue(join(dir, "queue.json"), new StubGitHubClient(), new StubLlmProvider(), join(dir, "conflict.ndjson"));
		await queue.load();
		const decidedStore = new DecidedPrStore(join(dir, "decided-prs.json"));

		const app = express();
		app.use(stubMembership(role));
		app.use("/admin", adminRouter(state, auditStore, queue, [], decidedStore));
		server = app.listen(0);
		await new Promise((resolve) => server.once("listening", resolve));

		const { status } = await postReset(server);
		expect(status).toBe(403);
	});
});
