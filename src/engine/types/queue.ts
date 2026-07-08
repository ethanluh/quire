import type { Bundle, ReviewCard } from "./core.js";

export type MergeQueueEntryStatus = "queued" | "landing" | "landed" | "reverted" | "conflict" | "aborted" | "investigating";

// Why a PR couldn't merge, distinct from the coarse "conflict" queue status: mergeConflict is
// a real text conflict Quire's own resolver couldn't clear; blocked/unstable/timedOut are
// GitHub policy/CI/latency, never a text conflict; unresolvable is the catch-all for the
// remaining edge cases (fork push rights, unexpected post-update state, base moved again).
export type MergeConflictKind = "mergeConflict" | "blocked" | "unstable" | "timedOut" | "unresolvable";

// The artifact a Managed Agents deep-investigation session produces for one escalated file —
// always a proposal for a human to accept/reject, never auto-applied (the fast resolver
// already couldn't clear this with confidence, so neither can an unreviewed agent output).
export interface DecisionPacket {
	rationale: string;
	evidence: ReadonlyArray<string>;
	testsRun: ReadonlyArray<string>;
	testResult: "passed" | "failed" | "unknown";
	confidence: "high" | "medium" | "low";
	openQuestion?: string;
	// Full file content to commit if accepted — Quire applies this itself via the existing
	// commitResolvedFiles pipeline rather than trusting a write the agent made directly.
	proposedResolution: string;
}

export interface FileInvestigation {
	path: string;
	prId: string;
	sessionId: string;
	status: "running" | "awaitingReview" | "accepted" | "rejected" | "failed";
	startedAt: string;
	decisionPacket?: DecisionPacket;
	failureReason?: string;
}

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
	// resolution either didn't apply (branch protection, failing checks) or failed (a text
	// conflict Quire's own hunk resolver couldn't confidently resolve). Surfaces the reason
	// per INV-6 rather than leaving the bundle silently stuck; POST /queue/:bundleId/retry
	// clears this to try again. `kind` is optional because entries persisted before it existed
	// won't have it — consumers must fall back to treating a missing kind as `mergeConflict`.
	conflict?: { prId: string; reason: string; kind?: MergeConflictKind; detectedAt: string };
	// Set when status is "aborted": a human gave up waiting on a bundle stuck mid-landing or
	// blocked on conflict, rather than letting it keep retrying. mergedPrIds is left untouched
	// so the partial-merge residual stays visible (INV-6) — abort does not revert what already
	// landed; see revertPr() for that as a separate, explicit action.
	abortedAt?: string;
	// Set when status is "landed": timestamp the final member PR merged. Used by listEntries()
	// to float recently-landed bundles to the top of the queue view, independent of enqueuedAt
	// (a bundle enqueued early but stuck behind a conflict can land well after ones queued
	// after it). Absent on entries persisted before this field existed.
	landedAt?: string;
	// Set when a deep-investigation session has been started for one or more escalated files
	// (status "investigating" while any are still "running", back to "conflict" — carrying
	// these for the review UI — once every investigation has a terminal outcome).
	investigations?: ReadonlyArray<FileInvestigation>;
}

export interface QueueState {
	entries: ReadonlyArray<MergeQueueEntry>;
}
