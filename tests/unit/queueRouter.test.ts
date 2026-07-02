import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import express from "express";
import type { Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { queueRouter } from "../../src/interface/server/routes/queue.js";
import { MergeQueue } from "../../src/engine/queue/mergeQueue.js";
import { StubGitHubClient } from "../../src/engine/github/stubClient.js";
import type { Bundle } from "../../src/engine/types/core.js";

function makeBundle(id: string): Bundle {
	return {
		id,
		direction: "add passwordless auth",
		effectSummary: "adds OTP-based login",
		members: [],
	};
}

describe("queueRouter — DELETE /:bundleId", () => {
	let server: Server;
	let baseUrl: string;
	let dataDir: string;
	let queue: MergeQueue;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "quire-test-"));
		queue = new MergeQueue(join(dataDir, "queue.json"), new StubGitHubClient());
		await queue.load();

		const app = express();
		app.use(express.json());
		app.use("/queue", queueRouter(queue));

		await new Promise<void>((resolve) => {
			server = app.listen(0, resolve);
		});
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("expected AddressInfo");
		baseUrl = `http://127.0.0.1:${address.port}`;
	});

	afterEach(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(dataDir, { recursive: true, force: true });
	});

	it("removes a queued bundle and it no longer appears in the listing", async () => {
		await queue.enqueue(makeBundle("bundle-1"));

		const res = await fetch(`${baseUrl}/queue/bundle-1`, { method: "DELETE" });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: "removed" });

		const listRes = await fetch(`${baseUrl}/queue`);
		expect(await listRes.json()).toEqual([]);
	});

	it("leaves a landed bundle in the queue", async () => {
		await queue.enqueue(makeBundle("bundle-1"));
		await queue.dequeueNext();

		await fetch(`${baseUrl}/queue/bundle-1`, { method: "DELETE" });

		const listRes = await fetch(`${baseUrl}/queue`);
		const entries = (await listRes.json()) as ReadonlyArray<{ bundleId: string }>;
		expect(entries.map((e) => e.bundleId)).toEqual(["bundle-1"]);
	});
});
