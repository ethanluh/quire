import type { Bundle, PullRequest, ReviewCard } from "../types/core.js";
import type { GitHubClient } from "../github/client.js";
import type { LlmProvider } from "../drift/effectList/provider.js";
import type { MergeabilityResult, MergeabilityState } from "../types/mergeability.js";
import type { MergeQueueEntry, QueueState } from "../types/queue.js";
import { loadState, saveState } from "./persistence.js";
import { resolveMergeConflict } from "./conflictResolution.js";
import { logConflictResolution } from "../instrumentation/logger.js";

const MERGEABLE_STATES: ReadonlyArray<MergeabilityState> = ["clean", "hasHooks", "draft"];

// Bounded backoff for GitHub's async mergeable_state computation — both the initial read
// and the re-check after updateBranch()/commitResolvedFiles() poll on this same schedule.
const DEFAULT_MERGEABILITY_POLL_DELAYS_MS: ReadonlyArray<number> = [1000, 2000, 4000, 4000, 4000];

type MergeableCheck = { ok: true } | { ok: false; reason: string };

export class MergeQueue {
	private state: QueueState = { entries: [] };

	constructor(
		private readonly statePath: string,
		private readonly github: GitHubClient,
		private readonly llmProvider: LlmProvider,
		private readonly conflictLogPath: string,
		private readonly mergeabilityPollDelaysMs: ReadonlyArray<number> = DEFAULT_MERGEABILITY_POLL_DELAYS_MS,
	) {}

	async load(): Promise<void> {
		this.state = await loadState(this.statePath);
	}

	private async persist(): Promise<void> {
		await saveState(this.statePath, this.state);
	}

	async enqueue(bundle: Bundle, card?: ReviewCard): Promise<void> {
		const entry: MergeQueueEntry = {
			bundleId: bundle.id,
			bundle,
			...(card !== undefined ? { card } : {}),
			enqueuedAt: new Date().toISOString(),
			status: "queued",
			revertedPrIds: [],
			mergedPrIds: [],
		};
		this.state = { entries: [...this.state.entries, entry] };
		await this.persist();
	}

	private async setEntry(bundleId: string, updated: MergeQueueEntry): Promise<void> {
		this.state = {
			entries: this.state.entries.map((e) => (e.bundleId === bundleId ? updated : e)),
		};
		await this.persist();
	}

	async dequeueNext(): Promise<MergeQueueEntry | undefined> {
		// Resume a bundle stuck in "landing" (e.g. the process crashed mid-merge) before
		// picking up a fresh "queued" one, so a partial merge is never silently abandoned.
		let entry = this.state.entries.find((e) => e.status === "landing");
		if (entry === undefined) {
			entry = this.state.entries.find((e) => e.status === "queued");
		}
		if (entry === undefined) return undefined;

		if (entry.status === "queued") {
			entry = { ...entry, status: "landing" };
			await this.setEntry(entry.bundleId, entry);
		}

		// Merge each member PR, skipping ones already merged in a prior attempt, and
		// persisting progress after every member so a crash here can resume cleanly.
		for (const pr of entry.bundle.members) {
			if (entry.mergedPrIds.includes(pr.id)) continue;

			const check = await this.ensureMergeable(entry.bundleId, pr);
			if (!check.ok) {
				const blocked: MergeQueueEntry = {
					...entry,
					status: "conflict",
					conflict: { prId: pr.id, reason: check.reason, detectedAt: new Date().toISOString() },
				};
				await this.setEntry(blocked.bundleId, blocked);
				return blocked;
			}

			await this.github.mergePullRequest(pr.repoOwner, pr.repoName, pr.number);
			entry = { ...entry, mergedPrIds: [...entry.mergedPrIds, pr.id] };
			await this.setEntry(entry.bundleId, entry);
		}

		const landed: MergeQueueEntry = { ...entry, status: "landed" };
		await this.setEntry(entry.bundleId, landed);
		return landed;
	}

	// The state table: clean/hasHooks/draft merge as normal; behind updates the branch for
	// free (no LLM); dirty goes to conflict resolution; blocked/unstable/unrecognized are
	// policy or CI gates an LLM has no business touching, so they bail immediately with no
	// resolution attempt at all.
	private async ensureMergeable(bundleId: string, pr: PullRequest): Promise<MergeableCheck> {
		let mergeability = await this.github.getMergeability(pr.repoOwner, pr.repoName, pr.number);
		if (mergeability.state === "unknownPending") {
			mergeability = await this.pollMergeability(pr);
		}

		if (MERGEABLE_STATES.includes(mergeability.state)) return { ok: true };

		if (mergeability.state === "behind") {
			if (mergeability.isFork) {
				return { ok: false, reason: "PR branch is behind base and lives in a fork this installation can't push to" };
			}
			await this.github.updateBranch(pr.repoOwner, pr.repoName, pr.number);
			const afterUpdate = await this.pollMergeability(pr);
			if (MERGEABLE_STATES.includes(afterUpdate.state)) return { ok: true };
			if (afterUpdate.state !== "dirty") {
				return { ok: false, reason: `branch update left the PR in an unexpected state: ${afterUpdate.state}` };
			}
			return this.attemptResolution(bundleId, pr, afterUpdate);
		}

		if (mergeability.state === "dirty") {
			return this.attemptResolution(bundleId, pr, mergeability);
		}

		const reason =
			mergeability.state === "blocked"
				? "blocked by branch protection or required reviews, not a merge conflict"
				: mergeability.state === "unstable"
					? "required status checks are failing or still pending, not a merge conflict"
					: mergeability.state === "unknownPending"
						? "GitHub did not finish computing mergeability in time"
						: "GitHub reported an unrecognized mergeability state";
		await logConflictResolution(this.conflictLogPath, bundleId, pr.id, "unresolved", reason);
		return { ok: false, reason };
	}

	private async attemptResolution(
		bundleId: string,
		pr: PullRequest,
		mergeability: MergeabilityResult,
	): Promise<MergeableCheck> {
		const result = await resolveMergeConflict(pr, mergeability, this.github, this.llmProvider);
		await logConflictResolution(
			this.conflictLogPath,
			bundleId,
			pr.id,
			result.resolved ? "resolved" : "unresolved",
			result.reason,
		);
		if (!result.resolved) return { ok: false, reason: result.reason ?? "conflict resolution failed" };

		// Give GitHub a moment to recompute mergeable_state after the new commit rather
		// than immediately racing its own async recomputation with a merge attempt.
		const after = await this.pollMergeability(pr);
		if (MERGEABLE_STATES.includes(after.state)) return { ok: true };
		return {
			ok: false,
			reason: `still not mergeable after resolving (${after.state}) — base branch likely moved again`,
		};
	}

	private async pollMergeability(pr: PullRequest): Promise<MergeabilityResult> {
		let result = await this.github.getMergeability(pr.repoOwner, pr.repoName, pr.number);
		for (const delayMs of this.mergeabilityPollDelaysMs) {
			if (result.state !== "unknownPending") return result;
			await this.sleep(delayMs);
			result = await this.github.getMergeability(pr.repoOwner, pr.repoName, pr.number);
		}
		return result;
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	async revertPr(bundleId: string, prId: string): Promise<string> {
		const entry = this.state.entries.find((e) => e.bundleId === bundleId);
		if (entry === undefined) throw new Error(`Bundle ${bundleId} not found in queue`);
		if (entry.status !== "landed") {
			throw new Error(`Cannot revert PR ${prId}: bundle ${bundleId} has not landed (status: ${entry.status})`);
		}

		const pr = entry.bundle.members.find((m) => m.id === prId);
		if (pr === undefined) throw new Error(`PR ${prId} not found in bundle ${bundleId}`);

		const revertUrl = await this.github.revertPullRequest(pr.repoOwner, pr.repoName, pr.number);

		await this.setEntry(bundleId, { ...entry, revertedPrIds: [...entry.revertedPrIds, prId] });
		return revertUrl;
	}

	async listEntries(): Promise<ReadonlyArray<MergeQueueEntry>> {
		return this.state.entries;
	}

	async getEntry(bundleId: string): Promise<MergeQueueEntry | undefined> {
		return this.state.entries.find((e) => e.bundleId === bundleId);
	}

	async removeQueued(bundleId: string): Promise<MergeQueueEntry | undefined> {
		const entry = this.state.entries.find((e) => e.bundleId === bundleId && e.status === "queued");
		if (entry === undefined) return undefined;
		this.state = { entries: this.state.entries.filter((e) => e.bundleId !== bundleId) };
		await this.persist();
		return entry;
	}

	// Clears a "conflict" entry back to "queued" so the next dequeueNext() tries again —
	// used whether a human fixed the underlying issue manually or just wants a retry.
	async retryConflict(bundleId: string): Promise<MergeQueueEntry | undefined> {
		const entry = this.state.entries.find((e) => e.bundleId === bundleId && e.status === "conflict");
		if (entry === undefined) return undefined;
		const { conflict: _conflict, ...rest } = entry;
		const retried: MergeQueueEntry = { ...rest, status: "queued" };
		await this.setEntry(bundleId, retried);
		return retried;
	}

	async clear(): Promise<void> {
		this.state = { entries: [] };
		await this.persist();
	}
}
