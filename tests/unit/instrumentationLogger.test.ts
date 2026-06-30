import { describe, it, expect, afterEach } from "@jest/globals";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	logGateDecision,
	logScreenResult,
	NdjsonInstrumentationSink,
} from "../../src/engine/instrumentation/logger.js";
import type { GateLog, ScreenLog } from "../../src/engine/types/instrumentation.js";

describe("logGateDecision / logScreenResult", () => {
	let dir: string;

	afterEach(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	it("appends a GateLog entry as ndjson", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-instrumentation-"));
		const path = join(dir, "gate.ndjson");
		const entry: GateLog = {
			prId: "pr-1",
			criterionName: "buildFailure",
			mode: "enforce",
			triggered: true,
			recordedAt: "2026-06-30T00:00:00.000Z",
		};

		await logGateDecision(path, entry);

		const lines = (await readFile(path, "utf8")).trim().split("\n");
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0] ?? "")).toEqual(entry);
	});

	it("appends a ScreenLog entry as ndjson", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-instrumentation-"));
		const path = join(dir, "screen.ndjson");
		const entry: ScreenLog = {
			prId: "pr-1",
			bundleId: "bundle-1",
			signalCount: 2,
			flagged: true,
			recordedAt: "2026-06-30T00:00:00.000Z",
		};

		await logScreenResult(path, entry);

		const lines = (await readFile(path, "utf8")).trim().split("\n");
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0] ?? "")).toEqual(entry);
	});
});

describe("NdjsonInstrumentationSink", () => {
	let dir: string;

	afterEach(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	it("writes gate and screen records to their own files", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-instrumentation-"));
		const gatePath = join(dir, "gate.ndjson");
		const screenPath = join(dir, "screen.ndjson");
		const sink = new NdjsonInstrumentationSink(gatePath, screenPath);

		await sink.recordGate({
			prId: "pr-1",
			criterionName: "duplicate",
			mode: "shadow",
			triggered: false,
			recordedAt: "2026-06-30T00:00:00.000Z",
		});
		await sink.recordScreen({
			prId: "pr-1",
			bundleId: "bundle-1",
			signalCount: 0,
			flagged: false,
			recordedAt: "2026-06-30T00:00:00.000Z",
		});

		expect(JSON.parse((await readFile(gatePath, "utf8")).trim())).toMatchObject({ prId: "pr-1" });
		expect(JSON.parse((await readFile(screenPath, "utf8")).trim())).toMatchObject({ prId: "pr-1" });
	});
});
