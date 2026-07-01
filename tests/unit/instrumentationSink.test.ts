import { describe, it, expect, afterEach } from "@jest/globals";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNdjsonInstrumentationSink } from "../../src/engine/instrumentation/logger.js";
import type { GateDecisionLog, DriftScreenLog } from "../../src/engine/types/instrumentation.js";

describe("createNdjsonInstrumentationSink", () => {
	let dir: string;

	afterEach(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	it("appends gate decisions and drift-screen results as separate NDJSON logs", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-sink-"));
		const gateLogPath = join(dir, "gate-decisions.ndjson");
		const driftScreenLogPath = join(dir, "drift-screen.ndjson");
		const sink = createNdjsonInstrumentationSink({ gateLogPath, driftScreenLogPath });

		const gateEntry: GateDecisionLog = {
			prId: "pr-1",
			criterionName: "buildFailure",
			mode: "enforce",
			triggered: true,
			recordedAt: "2026-01-01T00:00:00.000Z",
		};
		const driftEntry: DriftScreenLog = {
			bundleId: "bundle-1",
			prId: "pr-1",
			signalCount: 2,
			flagged: true,
			recordedAt: "2026-01-01T00:00:00.000Z",
		};

		await sink.logGateDecision?.(gateEntry);
		await sink.logDriftScreen?.(driftEntry);

		expect(JSON.parse((await readFile(gateLogPath, "utf8")).trim())).toEqual(gateEntry);
		expect(JSON.parse((await readFile(driftScreenLogPath, "utf8")).trim())).toEqual(driftEntry);
	});
});
