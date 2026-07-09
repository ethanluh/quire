import { describe, it, expect, afterEach } from "@jest/globals";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import type { Server } from "node:http";
import { judgeRouter } from "../../src/interface/server/routes/judge.js";
import { JudgeVerdictStore } from "../../src/engine/judge/judgeVerdictStore.js";
import { JudgeActionStore } from "../../src/engine/judge/judgeActionStore.js";
import { DecidedPrStore } from "../../src/engine/queue/decidedPrStore.js";
import type { JudgeActionRecord, JudgeVerdictRecord } from "../../src/engine/types/judge.js";

function makeVerdictRecord(bundleId: string): JudgeVerdictRecord {
	return {
		bundleId,
		inputsHash: `hash-${bundleId}`,
		mode: "shadow",
		computedAt: "2026-01-01T00:00:00.000Z",
		status: "ok",
		verdict: {
			gesture: "accept",
			confidence: 0.9,
			criteria: { direction: 0.9, drift: 0.9, blastRadius: 0.9, reversibility: 0.9, precedent: 0.9 },
			riskFlags: [],
			rationale: "x",
			precedentIds: [],
			modelId: "fake:judge-model",
		},
	};
}

function makeActionRecord(bundleId: string): JudgeActionRecord {
	return {
		bundleId,
		inputsHash: `hash-${bundleId}`,
		gesture: "accept",
		status: "verified",
		directionSummary: "x",
		rationale: "x",
		startedAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	};
}

describe("judgeRouter", () => {
	let server: Server;
	let dir: string;

	afterEach(async () => {
		if (server) await new Promise((resolve) => server.close(resolve));
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	async function call(path: string): Promise<{ status: number; body: unknown }> {
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("no address");
		const res = await fetch(`http://127.0.0.1:${address.port}${path}`);
		return { status: res.status, body: await res.json() };
	}

	it("lists verdicts and actions, and computes agreement, when the judge is fully configured", async () => {
		const verdictStore = new JudgeVerdictStore();
		await verdictStore.save(makeVerdictRecord("bundle-1"));
		const actionStore = new JudgeActionStore();
		await actionStore.save(makeActionRecord("bundle-1"));
		dir = await mkdtemp(join(tmpdir(), "quire-judge-router-"));
		const decidedStore = new DecidedPrStore(join(dir, "decided.json"));
		await decidedStore.markDecided(["pr-1"], "accept", { decidedBy: "alice", bundleId: "bundle-1" });

		const app = express();
		app.use("/judge", judgeRouter({ verdictStore, actionStore, decidedStore }));
		server = app.listen(0);

		const verdicts = await call("/judge/verdicts");
		expect(verdicts.status).toBe(200);
		expect((verdicts.body as unknown[]).length).toBe(1);

		const actions = await call("/judge/actions");
		expect((actions.body as unknown[]).length).toBe(1);

		const agreement = await call("/judge/agreement");
		expect(agreement.body).toMatchObject({ comparable: 1, agreements: 1, agreementRate: 1 });
	});

	it("degrades to empty results instead of erroring when the judge was never configured for this tenant", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-judge-router-"));
		const decidedStore = new DecidedPrStore(join(dir, "decided.json"));
		const app = express();
		app.use("/judge", judgeRouter({ decidedStore }));
		server = app.listen(0);

		expect((await call("/judge/verdicts")).body).toEqual([]);
		expect((await call("/judge/actions")).body).toEqual([]);
		const agreement = (await call("/judge/agreement")).body as Record<string, unknown>;
		expect(agreement).toMatchObject({ totalJudged: 0, comparable: 0 });
		// JSON has no "undefined" — an unset agreementRate is dropped from the response
		// entirely by res.json(), not sent as a literal null/undefined key.
		expect("agreementRate" in agreement).toBe(false);
	});
});
