import { describe, it, expect, afterEach } from "@jest/globals";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import express from "express";
import type { Server } from "node:http";
import { adminRouter } from "../../src/server/routes/admin.js";
import { createServerState } from "../../src/server/state.js";
import { AuditStore } from "../../src/gate/auditStore.js";
import { MergeQueue } from "../../src/queue/mergeQueue.js";
import { StubGitHubClient } from "../../src/github/stubClient.js";
import type { PullRequest, Bundle, ReviewCard } from "../../src/types/core.js";

function makePR(): PullRequest {
	return {
		id: "pr-1",
		repoOwner: "org",
		repoName: "repo",
		number: 1,
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
	};
}

function makeBundle(id: string): Bundle {
	return { id, direction: "add passwordless auth", members: [] };
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

	it("clears bundles, cards, shelf, audit entries, the merge queue, and the defer log", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-admin-"));
		const queuePath = join(dir, "queue.json");
		const deferLogPath = join(dir, "instrumentation", "defers.ndjson");
		await mkdir(dirname(deferLogPath), { recursive: true });
		await writeFile(deferLogPath, '{"bundleId":"b-1"}\n', "utf8");

		const state = createServerState();
		state.bundles.set("b-1", makeBundle("b-1"));
		state.cards.set("b-1", makeCard("b-1"));
		state.shelf.set("b-2", makeCard("b-2"));

		const auditStore = new AuditStore();
		auditStore.add(makePR(), "duplicate", "looks like a dup");

		const queue = new MergeQueue(queuePath, new StubGitHubClient());
		await queue.load();
		await queue.enqueue(makeBundle("b-3"));

		const app = express();
		app.use("/admin", adminRouter(state, auditStore, queue, deferLogPath));
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
		expect(await readFile(deferLogPath, "utf8")).toBe("");
	});
});
