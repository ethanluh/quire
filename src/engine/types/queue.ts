import type { Bundle } from "./core.js";

export type MergeQueueEntryStatus = "queued" | "landing" | "landed" | "reverted";

export interface MergeQueueEntry {
	bundleId: string;
	bundle: Bundle;
	enqueuedAt: string;
	status: MergeQueueEntryStatus;
	revertedPrIds: ReadonlyArray<string>;
	// Members merged so far. Tracked per-PR (not just a "landing" status flag) so that
	// dequeueNext() can resume a bundle that crashed partway through merging instead of
	// leaving it stuck in "landing" forever.
	mergedPrIds: ReadonlyArray<string>;
}

export interface QueueState {
	entries: ReadonlyArray<MergeQueueEntry>;
}
