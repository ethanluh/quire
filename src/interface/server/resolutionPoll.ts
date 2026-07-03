import type { MergeQueue } from "../../engine/queue/mergeQueue.js";
import { logConflictResolution } from "../../engine/instrumentation/logger.js";
import { notifyStateChanged } from "./changeEvents.js";

// Fallback for the conflict-resolution callback (routes/actionCallback.ts): the callback is
// the primary success signal, this only guards against it never arriving. Checks elapsed
// time only, not the Action run's actual status — a "resolving" entry stuck past the
// timeout becomes a normal "conflict", retryable through the existing /queue/:id/retry route.
export async function pollPendingResolutions(queue: MergeQueue, timeoutMs: number, conflictLogPath: string): Promise<void> {
	const entries = await queue.listEntries();
	const pending = entries.filter((e) => e.status === "resolving" && e.resolution !== undefined);

	let timedOut = false;
	for (const entry of pending) {
		const resolution = entry.resolution;
		if (resolution === undefined) continue;

		const ageMs = Date.now() - new Date(resolution.dispatchedAt).getTime();
		if (ageMs <= timeoutMs) continue;

		const reason = `conflict-resolution workflow did not report back within ${Math.round(timeoutMs / 60_000)} minutes`;
		await queue.markResolutionFailed(entry.bundleId, resolution.prId, reason);
		await logConflictResolution(conflictLogPath, entry.bundleId, resolution.prId, "unresolved", reason);
		timedOut = true;
	}

	// No open tab initiated this — it's a background timeout — so push the change instead of
	// waiting for the next client poll tick.
	if (timedOut) notifyStateChanged();
}
