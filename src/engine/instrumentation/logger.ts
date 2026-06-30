import type { ReviewCard } from "../types/core.js";
import type { DeferLog, HumanFinding } from "../types/instrumentation.js";
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
