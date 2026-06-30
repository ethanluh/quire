import type { ReviewCard } from "../types/core.js";
import type {
	DeferLog,
	GateLog,
	HumanFinding,
	InstrumentationSink,
	ScreenLog,
} from "../types/instrumentation.js";
import { appendNdjson } from "./store.js";

export async function logDefer(
	logPath: string,
	bundleId: string,
	card: ReviewCard,
): Promise<void> {
	const entry: DeferLog = {
		bundleId,
		deferredAt: new Date().toISOString(),
		driftFlagged: card.drift.status === "flagged",
	};
	await appendNdjson(logPath, entry);
}

export async function logHumanFinding(logPath: string, finding: HumanFinding): Promise<void> {
	await appendNdjson(logPath, finding);
}

export async function logGateDecision(logPath: string, entry: GateLog): Promise<void> {
	await appendNdjson(logPath, entry);
}

export async function logScreenResult(logPath: string, entry: ScreenLog): Promise<void> {
	await appendNdjson(logPath, entry);
}

// Default NDJSON-backed InstrumentationSink, following the same file-per-log-kind layout
// as the defer log. Swap in a different InstrumentationSink to send this data elsewhere
// without touching the pipeline.
export class NdjsonInstrumentationSink implements InstrumentationSink {
	constructor(
		private readonly gateLogPath: string,
		private readonly screenLogPath: string,
	) {}

	async recordGate(entry: GateLog): Promise<void> {
		await logGateDecision(this.gateLogPath, entry);
	}

	async recordScreen(entry: ScreenLog): Promise<void> {
		await logScreenResult(this.screenLogPath, entry);
	}
}
