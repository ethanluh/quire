import type { Bundle, PullRequest, ReviewCard } from "../types/core.js";
import type { GitHubClient } from "../github/client.js";
import type { MergeabilityResult, MergeabilityState } from "../types/mergeability.js";
import type { MergeQueueEntry, QueueState } from "../types/queue.js";
import { loadState, saveState } from "./persistence.js";
import { resolveMergeConflict } from "./conflictResolution.js";
import { logConflictResolution } from "../instrumentation/logger.js";

const MERGEABLE_STATES: ReadonlyArray<MergeabilityState> = ["clean", "hasHooks", "draft"];

// Bounded backoff for GitHub's async mergeable_state computation — both the initial read
// and the re-check after updateBranch()/commitResolvedFiles() poll on this same schedule.
const DEFAULT_MERGEABILITY_POLL_DELAYS_MS: ReadonlyArray<number> = [1000, 2000, 4000, 4000, 4000];

type MergeableCheck =
	| { ok: true; alreadyMerged?: boolean }
	| { ok: false; reason: string }
	| { ok: "pending"; prId: string; workflowRunId?: number; callbackToken: string };

export class MergeQueue {
	private state: QueueState = { entries: [] };

	constructor(
		private readonly statePath: string,
		private readonly github: GitHubClient,
		// Base URL the conflict-resolution Action calls back to (e.g. "https://host/callbacks/
		// action-resolution") — undefined when QUIRE_PUBLIC_URL isn't configured, in which case
		// dispatching a conflict fails fast rather than waiting on a callback that can't arrive.
		private readonly callbackBaseUrl: string | undefined,
		private readonly conflictLogPath: string,
		private readonly mergeabilityPollDelaysMs: ReadonlyArray<number> = DEFAULT_MERGEABILITY_POLL_DELAYS_MS,
	) {}

	async load(): Promise<void> {
		this.state = await loadState(this.statePath);
	}

	private async persist(): Promise<void> {
		await saveState(this.statePath, this.state);
	}

	// dequeueNext()/markResolutionSucceeded()/markResolutionFailed()/retryConflict() are each
	// reachable from independent triggers (a human's manual "Process" click, autoMergeOnAccept,
	// the conflict-resolution Action's callback, the workflow_run webhook, and the timeout poll
	// fallback) that don't coordinate with each other. Chaining every call through this lock
	// serializes them onto `this.state` instead of letting two land concurrently and silently
	// drop one side's update — mirrors refreshRepoQueue.ts's per-repo `inFlight` map, collapsed
	// to a single chain since only one queue entry is ever actively processed at a time.
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
		// "resolving" entries are deliberately excluded from both scans — they're not stuck,
		// they're waiting on the target repo's Action, and only leave "resolving" via the
		// callback route or the poll-timeout fallback (see resolutionPoll.ts).
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
			if (check.ok === "pending") {
				const resolving: MergeQueueEntry = {
					...entry,
					status: "resolving",
					resolution: {
						prId: check.prId,
						repoOwner: pr.repoOwner,
						repoName: pr.repoName,
						...(check.workflowRunId !== undefined ? { workflowRunId: check.workflowRunId } : {}),
						callbackToken: check.callbackToken,
						dispatchedAt: new Date().toISOString(),
					},
				};
				await this.setEntry(resolving.bundleId, resolving);
				return resolving;
			}
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
		const result = await resolveMergeConflict(bundleId, pr, mergeability, this.github, this.callbackBaseUrl);

		if (result.status === "dispatched") {
			await logConflictResolution(this.conflictLogPath, bundleId, pr.id, "unresolved", "dispatched to conflict-resolution Action");
			return {
				ok: "pending",
				prId: result.prId,
				callbackToken: result.callbackToken,
				...(result.workflowRunId !== undefined ? { workflowRunId: result.workflowRunId } : {}),
			};
		}

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
	// whether a human fixed the underlying issue manually or just wants a retry. Also accepts
	// "resolving": a human giving up on the dispatched Action before its callback or the poll
	// timeout would otherwise notice, e.g. because they can already see from the linked run
	// that it's thrashing. That manual override is logged the same way the poll timeout logs
	// one, since it's the same "gave up waiting on the Action" outcome either way.
	async retryConflict(bundleId: string): Promise<MergeQueueEntry | undefined> {
		return this.withLock(() => this.retryConflictLocked(bundleId));
	}

	private async retryConflictLocked(bundleId: string): Promise<MergeQueueEntry | undefined> {
		const entry = this.state.entries.find(
			(e) => e.bundleId === bundleId && (e.status === "conflict" || e.status === "resolving"),
		);
		if (entry === undefined) return undefined;
		if (entry.resolution !== undefined) {
			await logConflictResolution(
				this.conflictLogPath,
				bundleId,
				entry.resolution.prId,
				"unresolved",
				"manually retried before the conflict-resolution Action reported back",
			);
		}
		const { conflict: _conflict, resolution: _resolution, ...rest } = entry;
		const retried: MergeQueueEntry = { ...rest, status: "queued" };
		await this.setEntry(bundleId, retried);
		return retried;
	}

	// The conflict-resolution Action pushed a resolving commit and reported success (via
	// callback, or the poll fallback finding the run completed) — the PR's branch should now
	// be mergeable, so go back to "queued" and let the next dequeueNext() re-attempt the merge.
	async markResolutionSucceeded(bundleId: string): Promise<MergeQueueEntry | undefined> {
		return this.withLock(() => this.markResolutionSucceededLocked(bundleId));
	}

	private async markResolutionSucceededLocked(bundleId: string): Promise<MergeQueueEntry | undefined> {
		const entry = this.state.entries.find((e) => e.bundleId === bundleId && e.status === "resolving");
		if (entry === undefined) return undefined;
		const { resolution: _resolution, ...rest } = entry;
		const requeued: MergeQueueEntry = { ...rest, status: "queued" };
		await this.setEntry(bundleId, requeued);
		return requeued;
	}

	// The Action reported it couldn't resolve the conflict (or the workflow_run webhook / poll
	// fallback reported the run ended without one) — surface the reason per INV-6, retryable
	// via the normal conflict flow.
	async markResolutionFailed(bundleId: string, prId: string, reason: string): Promise<MergeQueueEntry | undefined> {
		return this.withLock(() => this.markResolutionFailedLocked(bundleId, prId, reason));
	}

	private async markResolutionFailedLocked(bundleId: string, prId: string, reason: string): Promise<MergeQueueEntry | undefined> {
		const entry = this.state.entries.find((e) => e.bundleId === bundleId && e.status === "resolving");
		if (entry === undefined) return undefined;
		const { resolution: _resolution, ...rest } = entry;
		const failed: MergeQueueEntry = {
			...rest,
			status: "conflict",
			conflict: { prId, reason, detectedAt: new Date().toISOString() },
		};
		await this.setEntry(bundleId, failed);
		return failed;
	}

	// Used by the workflow_run webhook handler to find which (if any) resolving entry a
	// completed Action run belongs to, without exposing internal state directly.
	async findResolvingByWorkflowRun(repoOwner: string, repoName: string, workflowRunId: number): Promise<MergeQueueEntry | undefined> {
		return this.state.entries.find(
			(e) =>
				e.status === "resolving" &&
				e.resolution?.workflowRunId === workflowRunId &&
				e.resolution.repoOwner === repoOwner &&
				e.resolution.repoName === repoName,
		);
	}

	async clear(): Promise<void> {
		this.state = { entries: [] };
		await this.persist();
	}
}
