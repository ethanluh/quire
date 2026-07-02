import type { Bundle, ReviewCard } from "./core.js";

export type MergeQueueEntryStatus = "queued" | "landing" | "landed" | "reverted" | "conflict";

export interface MergeQueueEntry {
	bundleId: string;
	bundle: Bundle;
	// Optional only for entries persisted before this field existed, or lightweight test
	// fixtures. Real accepts (gestures.ts) always set it, so a removed-while-queued bundle
	// can be restored to the review queue with the exact card the human last saw.
	card?: ReviewCard;
	enqueuedAt: string;
	status: MergeQueueEntryStatus;
	revertedPrIds: ReadonlyArray<string>;
	// Members merged so far. Tracked per-PR (not just a "landing" status flag) so that
	// dequeueNext() can resume a bundle that crashed partway through merging instead of
	// leaving it stuck in "landing" forever.
	mergedPrIds: ReadonlyArray<string>;
	// Set when status is "conflict": a member PR couldn't be landed and automated
	// resolution either didn't apply (branch protection, failing checks) or failed
	// (genuine text conflict a model couldn't confidently resolve). Surfaces the reason
	// per INV-6 rather than leaving the bundle silently stuck; POST /queue/:bundleId/retry
	// clears this to try again.
	conflict?: { prId: string; reason: string; detectedAt: string };
}

export interface QueueState {
	entries: ReadonlyArray<MergeQueueEntry>;
}
