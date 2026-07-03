import type { Bundle, PullRequest, ReviewCard } from "../types/core.js";
import type { GitHubClient } from "../github/client.js";
import type { LlmProviderHolder } from "../drift/effectList/providerHolder.js";
import type { MergeabilityResult, MergeabilityState } from "../types/mergeability.js";
import type { MergeQueueEntry, QueueState } from "../types/queue.js";
import { loadState, saveState } from "./persistence.js";
import { resolveMergeConflict } from "./conflictResolution.js";
import { logConflictResolution } from "../instrumentation/logger.js";

const MERGEABLE_STATES: ReadonlyArray<MergeabilityState> = ["clean", "hasHooks", "draft"];

// Bounded backoff for GitHub's async mergeable_state computation — both the initial read
// and the re-check after updateBranch()/commitResolvedFiles() poll on this same schedule.
const DEFAULT_MERGEABILITY_POLL_DELAYS_MS: ReadonlyArray<number> = [1000, 2000, 4000, 4000, 4000];

type MergeableCheck = { ok: true; alreadyMerged?: boolean } | { ok: false; reason: string };

export class MergeQueue {
	private state: QueueState = { entries: [] };

	constructor(
		private readonly statePath: string,
		private readonly github: GitHubClient,
		// Snapshotted once per resolution attempt (see attemptResolution) rather than read
		// through the holder on every call, so a mid-run account connect/disconnect can't
		// split one attempt's batched hunk-resolution call across two different providers.
		private readonly llmProviderHolder: LlmProviderHolder,
		private readonly conflictLogPath: string,
		private readonly mergeabilityPollDelaysMs: ReadonlyArray<number> = DEFAULT_MERGEABILITY_POLL_DELAYS_MS,
	) {}

	async load(): Promise<void> {
		this.state = await loadState(this.statePath);
	}

	private async persist(): Promise<void> {
		await saveState(this.statePath, this.state);
	}

	// dequeueNext() and retryConflict() are each reachable from independent triggers (a
	// human's manual "Process" click, autoMergeOnAccept, and the review UI's retry button)
	// that don't coordinate with each other. Chaining every call through this lock serializes
	// them onto `this.state` instead of letting two land concurrently and silently drop one
	// side's update — mirrors refreshRepoQueue.ts's per-repo `inFlight` map, collapsed to a
	// single chain since only one queue entry is ever actively processed at a time.
	private lock: Promise<unknown> = Promise.resolve();
	private withLock<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.lock.then(fn, fn);
		this.lock = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
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
		return this.withLock(() => this.dequeueNextLocked());
	}

	private async dequeueNextLocked(): Promise<MergeQueueEntry | undefined> {
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

			// alreadyMerged means GitHub reports this PR merged (out of band, or a prior
			// attempt that merged it but crashed before recording mergedPrIds) — calling
			// mergePullRequest again would just 405 against an already-closed PR.
			if (check.alreadyMerged !== true) {
				await this.github.mergePullRequest(pr.repoOwner, pr.repoName, pr.number);
			}
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
		// Checked before anything looks at `state`: GitHub never computes mergeable_state for
		// a closed/merged PR (it reports "unknown" forever), so without this a PR that's
		// already merged — out of band, or by a prior attempt that crashed before persisting
		// mergedPrIds — would poll out to a timeout and get misreported as a conflict.
		if (mergeability.merged) return { ok: true, alreadyMerged: true };
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
		const result = await resolveMergeConflict(pr, mergeability, this.github, this.llmProviderHolder.snapshot());

		await logConflictResolution(
			this.conflictLogPath,
			bundleId,
			pr.id,
			result.status === "resolved" ? "resolved" : "unresolved",
			result.status === "failed" ? result.reason : undefined,
		);
		if (result.status === "failed") return { ok: false, reason: result.reason };

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

	// Clears a "conflict" entry back to "queued" so the next dequeueNext() tries again — used
	// whether a human fixed the underlying issue manually or just wants a retry.
	async retryConflict(bundleId: string): Promise<MergeQueueEntry | undefined> {
		return this.withLock(() => this.retryConflictLocked(bundleId));
	}

	private async retryConflictLocked(bundleId: string): Promise<MergeQueueEntry | undefined> {
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

	// Best-effort: catches "behind" drift on queued PRs early via GitHub's free branch-update
	// merge, before it's their turn in dequeueNext(). Without this, a bundle sitting behind
	// several others that land ahead of it only gets checked once it's finally dequeued — by
	// then main has moved further and what would have been a free fast-forward has calcified
	// into a real "dirty" conflict needing the LLM Action. Read-only w.r.t. `this.state` (no
	// setEntry/persist), so it deliberately doesn't go through withLock — it must not block
	// dequeueNext()/retryConflict() for however long a pass over every queued PR takes, and a
	// concurrent updateBranch() call from dequeueNext() picking the same PR is a harmless
	// duplicate, not a correctness issue.
	async refreshQueuedBranches(): Promise<void> {
		const queued = this.state.entries.filter((e) => e.status === "queued");
		for (const entry of queued) {
			for (const pr of entry.bundle.members) {
				try {
					const mergeability = await this.github.getMergeability(pr.repoOwner, pr.repoName, pr.number);
					if (mergeability.merged || mergeability.isFork || mergeability.state !== "behind") continue;
					await this.github.updateBranch(pr.repoOwner, pr.repoName, pr.number);
				} catch (err) {
					// Best-effort — dequeueNext() re-discovers whatever state this PR is
					// actually in (still behind, now dirty, or fine) and handles it normally.
					console.error(`Queue refresh failed for ${pr.repoOwner}/${pr.repoName}#${pr.number}:`, err);
				}
			}
		}
	}
}
