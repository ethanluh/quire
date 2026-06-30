import type { Bundle } from "./core.js";

export type MergeQueueEntryStatus = "queued" | "landing" | "landed" | "reverted";

export interface MergeQueueEntry {
	bundleId: string;
	bundle: Bundle;
	enqueuedAt: string;
	status: MergeQueueEntryStatus;
	revertedPrIds: ReadonlyArray<string>;
}

export interface QueueState {
	entries: ReadonlyArray<MergeQueueEntry>;
}
