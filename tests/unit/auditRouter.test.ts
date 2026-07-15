import { describe, it, expect, afterEach } from "@jest/globals";
import express from "express";
import type { Server } from "node:http";
import { auditRouter } from "../../src/interface/server/routes/audit.js";
import { AuditStore } from "../../src/engine/gate/auditStore.js";
import type { PullRequest } from "../../src/engine/types/core.js";

function makePR(overrides: Partial<PullRequest> = {}): PullRequest {
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
		labels: [],
		assignees: [],
		symbolsTouched: [],
		testNamesChanged: [],
		ciStatus: "success",
		...overrides,
	};
}

describe("auditRouter", () => {
	let server: Server;

	afterEach(async () => {
		if (server) await new Promise((resolve) => server.close(resolve));
	});

	function setup() {
		const auditStore = new AuditStore();
		const app = express();
		app.use(express.json());
		// Real requests run behind resolveMembership, which always sets res.locals.membership;
		// the audit routes are owner/admin-gated, so stand in an owner here.
		app.use((_req, res, next) => {
			res.locals.membership = { teamId: "test-team", role: "owner" };
			next();
		});
		app.use("/audit", auditRouter(auditStore));
		server = app.listen(0);
		return { auditStore };
	}

	async function call(method: string, path: string): Promise<{ status: number; body: unknown }> {
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("no address");
		const res = await fetch(`http://127.0.0.1:${address.port}${path}`, { method });
		return { status: res.status, body: await res.json() };
	}

	it("GET lists every audit entry", async () => {
		const { auditStore } = setup();
		await new Promise((resolve) => server.once("listening", resolve));
		await auditStore.add(makePR(), "duplicate", "looks like a dup");

		const { status, body } = await call("GET", "/audit");

		expect(status).toBe(200);
		expect((body as unknown[]).length).toBe(1);
	});

	it("POST /:entryId/overturn marks the entry overturned", async () => {
		const { auditStore } = setup();
		await new Promise((resolve) => server.once("listening", resolve));
		await auditStore.add(makePR(), "duplicate", "looks like a dup");
		const entryId = auditStore.list()[0]?.id ?? "";

		const { status, body } = await call("POST", `/audit/${entryId}/overturn`);

		expect(status).toBe(200);
		expect(body).toEqual({ status: "overturned", entryId });
		expect(auditStore.list()[0]?.overturnedAt).not.toBeNull();
	});

	it("returns 404 for overturning an entry that doesn't exist", async () => {
		setup();
		await new Promise((resolve) => server.once("listening", resolve));

		const { status, body } = await call("POST", "/audit/missing/overturn");

		expect(status).toBe(404);
		expect(body).toEqual({ error: "Audit entry not found" });
	});
});
