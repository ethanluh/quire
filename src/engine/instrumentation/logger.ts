import type { ReviewCard } from "../types/core.js";
import type {
	ConflictResolutionLog,
	DeferLog,
	HumanFinding,
	InstrumentationSink,
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

export async function logConflictResolution(
	logPath: string,
	bundleId: string,
	prId: string,
	outcome: "resolved" | "unresolved",
	reason?: string,
): Promise<void> {
	const entry: ConflictResolutionLog = {
		bundleId,
		prId,
		outcome,
		...(reason !== undefined ? { reason } : {}),
		recordedAt: new Date().toISOString(),
	};
	await appendNdjson(logPath, entry);
}

export interface NdjsonInstrumentationPaths {
	gateLogPath: string;
	driftScreenLogPath: string;
	judgeDecisionLogPath: string;
}

// The pluggable sink the pipeline calls into for gate/drift-screen/judge logging (see
// types/instrumentation.ts). NDJSON is the same on-disk format as the existing
// defer log; swap this factory out for a different InstrumentationSink without
// touching the pipeline.
export function createNdjsonInstrumentationSink(
	paths: NdjsonInstrumentationPaths,
): InstrumentationSink {
	return {
		logGateDecision: (entry) => appendNdjson(paths.gateLogPath, entry),
		logDriftScreen: (entry) => appendNdjson(paths.driftScreenLogPath, entry),
		logJudgeVerdict: (entry) => appendNdjson(paths.judgeDecisionLogPath, entry),
	};
}
