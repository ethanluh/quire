import type { Bundle, PullRequest, ReviewCard } from "../types/core.js";
import type { GitHubClient } from "../github/client.js";
import type { LlmProviderHolder } from "../drift/effectList/providerHolder.js";
import type { MergeabilityResult, MergeabilityState } from "../types/mergeability.js";
import type { FileInvestigation, MergeConflictKind, MergeQueueEntry, MergeQueueEntryStatus, QueueState } from "../types/queue.js";
import { loadState, saveState } from "./persistence.js";
import { resolveMergeConflict } from "./conflictResolution.js";
import type { ConflictHunkEscalation } from "./conflictResolution.js";
import { logConflictResolution } from "../instrumentation/logger.js";
import { pollInvestigationSession, startInvestigationSession } from "./deepConflictInvestigation.js";
import type { DeepResolverAgentRef } from "./deepConflictInvestigation.js";
import type { ManagedAgentsClient } from "./managedAgentsClient.js";

const MERGEABLE_STATES: ReadonlyArray<MergeabilityState> = ["clean", "hasHooks", "draft"];

// Bounded backoff for GitHub's async mergeable_state computation — both the initial read
// and the re-check after updateBranch()/commitResolvedFiles() poll on this same schedule.
export const DEFAULT_MERGEABILITY_POLL_DELAYS_MS: ReadonlyArray<number> = [1000, 2000, 4000, 4000, 4000];

type MergeableCheck =
	| { ok: true; alreadyMerged?: boolean }
	| { ok: false; reason: string; kind: MergeConflictKind; investigating?: { path: string; sessionId: string } };

// Live, swappable dependencies for the opt-in Managed-Agents deep-investigation tier — same
// "getter bag" shape as shouldFlagForFleet, gathered into one object because this tier needs
// several collaborators together (an availability check, a client, agent bootstrap, and a
// token minter) rather than one boolean.
export interface DeepInvestigationDeps {
	shouldEnable: (owner: string, repo: string) => boolean;
	// undefined when no Anthropic account is connected — the tier has nothing to run against.
	getClient: () => ManagedAgentsClient | undefined;
	ensureAgent: (client: ManagedAgentsClient) => Promise<DeepResolverAgentRef>;
	mintRepoToken: (owner: string, repo: string) => Promise<string>;
}

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
		// Live, swappable, same shape as llmProviderHolder — read at the moment a resolution
		// fails rather than captured once at construction, so a mid-run settings change takes
		// effect on the very next failure. Takes the failing PR's owner/repo since this setting
		// is per-repo, not team-wide (a team can flag conflicts for one repo's fleet but not
		// another's).
		private readonly shouldFlagForFleet: (owner: string, repo: string) => boolean = () => false,
		private readonly deepInvestigation?: DeepInvestigationDeps,
	) {}

	async load(): Promise<void> {
		this.state = await loadState(this.statePath);
	}

	private async persist(): Promise<void> {
		await saveState(this.statePath, this.state);
	}

	// dequeueNext(), reattempt(), and abort() are each reachable from independent triggers (a
	// human's manual "Process" click, autoMergeOnAccept, and the review UI's retry/abort
	// buttons) that don't coordinate with each other. Chaining every call through this lock
	// serializes them onto `this.state` instead of letting two land concurrently and silently
	// drop one side's update — mirrors refreshRepoQueue.ts's per-repo keyed refresh lock,
	// collapsed to a single chain since only one queue entry is ever actively processed at a time.
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
				const investigation: FileInvestigation | undefined =
					check.investigating !== undefined
						? {
								path: check.investigating.path,
								prId: pr.id,
								sessionId: check.investigating.sessionId,
								status: "running",
								startedAt: new Date().toISOString(),
							}
						: undefined;
				const blocked: MergeQueueEntry = {
					...entry,
					status: investigation !== undefined ? "investigating" : "conflict",
					conflict: { prId: pr.id, reason: check.reason, kind: check.kind, detectedAt: new Date().toISOString() },
					...(investigation !== undefined ? { investigations: [...(entry.investigations ?? []), investigation] } : {}),
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

		const landed: MergeQueueEntry = { ...entry, status: "landed", landedAt: new Date().toISOString() };
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
				return {
					ok: false,
					reason: "PR branch is behind base and lives in a fork this installation can't push to",
					kind: "unresolvable",
				};
			}
			await this.github.updateBranch(pr.repoOwner, pr.repoName, pr.number);
			const afterUpdate = await this.pollMergeability(pr);
			if (MERGEABLE_STATES.includes(afterUpdate.state)) return { ok: true };
			if (afterUpdate.state !== "dirty") {
				return {
					ok: false,
					reason: `branch update left the PR in an unexpected state: ${afterUpdate.state}`,
					kind: "unresolvable",
				};
			}
			return this.attemptResolution(bundleId, pr, afterUpdate);
		}

		if (mergeability.state === "dirty") {
			return this.attemptResolution(bundleId, pr, mergeability);
		}

		const outcomeByState: Partial<Record<typeof mergeability.state, { reason: string; kind: MergeConflictKind }>> = {
			blocked: { reason: "blocked by branch protection or required reviews, not a merge conflict", kind: "blocked" },
			unstable: { reason: "required status checks are failing or still pending, not a merge conflict", kind: "unstable" },
			unknownPending: { reason: "GitHub did not finish computing mergeability in time", kind: "timedOut" },
		};
		const outcome = outcomeByState[mergeability.state] ?? {
			reason: "GitHub reported an unrecognized mergeability state",
			kind: "unresolvable" as const,
		};
		await logConflictResolution(this.conflictLogPath, bundleId, pr.id, "unresolved", outcome.reason);
		return { ok: false, reason: outcome.reason, kind: outcome.kind };
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
		if (result.status === "failed") {
			// Both escalation avenues are independent opt-ins (see the plan this implements) —
			// a user can have either, both, or neither enabled, so they run unconditionally of
			// each other rather than one short-circuiting the other.
			let investigating: { path: string; sessionId: string } | undefined;
			if (result.escalation !== undefined) {
				investigating = await this.tryStartInvestigation(pr, result.escalation);
			}
			if (this.shouldFlagForFleet(pr.repoOwner, pr.repoName)) {
				await this.github.postComment(
					pr.repoOwner,
					pr.repoName,
					pr.number,
					`Quire could not automatically resolve this PR's merge conflict:\n\n${result.reason}`,
				);
			}
			return {
				ok: false,
				reason: result.reason,
				kind: "mergeConflict",
				...(investigating !== undefined ? { investigating } : {}),
			};
		}

		// Give GitHub a moment to recompute mergeable_state after the new commit rather
		// than immediately racing its own async recomputation with a merge attempt.
		const after = await this.pollMergeability(pr);
		if (MERGEABLE_STATES.includes(after.state)) return { ok: true };
		return {
			ok: false,
			reason: `still not mergeable after resolving (${after.state}) — base branch likely moved again`,
			kind: "unresolvable",
		};
	}

	// Best-effort: any failure here (no Anthropic account connected, a transient API error
	// minting the repo token or starting the session) just falls back to the plain "conflict"
	// path — the fast resolver's failure reason is never lost, this only ever adds an
	// additional avenue for a human to eventually clear it.
	private async tryStartInvestigation(
		pr: PullRequest,
		escalation: ConflictHunkEscalation,
	): Promise<{ path: string; sessionId: string } | undefined> {
		const deps = this.deepInvestigation;
		if (deps === undefined || !deps.shouldEnable(pr.repoOwner, pr.repoName)) return undefined;
		const client = deps.getClient();
		if (client === undefined) return undefined;
		try {
			const agentRef = await deps.ensureAgent(client);
			const repoToken = await deps.mintRepoToken(pr.repoOwner, pr.repoName);
			const { sessionId } = await startInvestigationSession(client, agentRef, pr, escalation, repoToken);
			return { path: escalation.path, sessionId };
		} catch (err) {
			console.error(`Deep conflict investigation failed to start for ${pr.repoOwner}/${pr.repoName}#${pr.number}:`, err);
			return undefined;
		}
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
		if (!entry.mergedPrIds.includes(prId)) {
			throw new Error(`Cannot revert PR ${prId}: it was not merged by bundle ${bundleId} (status: ${entry.status})`);
		}

		const pr = entry.bundle.members.find((m) => m.id === prId);
		if (pr === undefined) throw new Error(`PR ${prId} not found in bundle ${bundleId}`);

		const revertUrl = await this.github.revertPullRequest(pr.repoOwner, pr.repoName, pr.number);

		await this.setEntry(bundleId, { ...entry, revertedPrIds: [...entry.revertedPrIds, prId] });
		return revertUrl;
	}

	// Floats everything still actionable ("queued", "landing", "conflict", "investigating",
	// "aborted") above "landed" entries, most-recently-enqueued first, so a bundle waiting in
	// the queue is visible without scrolling past a growing history of already-merged bundles.
	// "landed" entries trail at the bottom, most recently landed first. This is a display-only
	// sort — it reads this.state.entries, it never writes it, and dequeueNextLocked/
	// refreshQueuedBranches/pollInvestigationsLocked all read this.state.entries directly rather
	// than through here, so actual processing order is untouched.
	async listEntries(): Promise<ReadonlyArray<MergeQueueEntry>> {
		const active = this.state.entries
			.filter((e) => e.status !== "landed")
			.sort((a, b) => (b.enqueuedAt ?? "").localeCompare(a.enqueuedAt ?? ""));
		const landed = this.state.entries
			.filter((e) => e.status === "landed")
			.sort((a, b) => (b.landedAt ?? "").localeCompare(a.landedAt ?? ""));
		return [...active, ...landed];
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

	// Clears a "conflict" or "aborted" entry back to "queued" so the next dequeueNext() tries
	// again — used whether a human fixed the underlying issue manually, changed their mind
	// about an abort, or just wants another attempt. mergedPrIds is untouched, so a bundle
	// that partially landed before conflicting/being aborted resumes from where it left off.
	async reattempt(bundleId: string): Promise<MergeQueueEntry | undefined> {
		return this.withLock(() => this.reattemptLocked(bundleId));
	}

	private async reattemptLocked(bundleId: string): Promise<MergeQueueEntry | undefined> {
		const entry = this.state.entries.find((e) => e.bundleId === bundleId && (e.status === "conflict" || e.status === "aborted"));
		if (entry === undefined) return undefined;
		return this.clearToQueued(entry);
	}

	// Same "conflict" → "queued" transition as reattempt(), but looked up by the PR a
	// conflict was recorded against rather than by bundle id — the caller (a GitHub webhook
	// on new commits) only knows which PR just changed, not which bundle it belongs to.
	// Deliberately excludes "aborted": that status is an explicit human give-up, which a
	// stray push shouldn't silently override the way a fresh conflict-clearing commit does.
	async reattemptForPr(prId: string): Promise<MergeQueueEntry | undefined> {
		return this.withLock(() => this.reattemptForPrLocked(prId));
	}

	private async reattemptForPrLocked(prId: string): Promise<MergeQueueEntry | undefined> {
		const entry = this.state.entries.find((e) => e.status === "conflict" && e.conflict?.prId === prId);
		if (entry === undefined) return undefined;
		return this.clearToQueued(entry);
	}

	private async clearToQueued(entry: MergeQueueEntry): Promise<MergeQueueEntry> {
		const { conflict: _conflict, abortedAt: _abortedAt, ...rest } = entry;
		const retried: MergeQueueEntry = { ...rest, status: "queued" };
		await this.setEntry(entry.bundleId, retried);
		return retried;
	}

	// A human (or another tool) merged a member PR directly on GitHub instead of going
	// through dequeueNext() — the webhook on a `closed` event with `merged: true` calls this
	// to keep the queue's view of reality accurate instead of waiting for the next
	// dequeueNext()/ensureMergeable() pass to notice via `alreadyMerged`. Idempotent: a PR
	// already recorded in mergedPrIds (Quire's own merge, or a redelivered webhook) matches no
	// entry below and this is a no-op.
	async recordExternalMerge(prId: string): Promise<MergeQueueEntry | undefined> {
		return this.withLock(() => this.recordExternalMergeLocked(prId));
	}

	private async recordExternalMergeLocked(prId: string): Promise<MergeQueueEntry | undefined> {
		const found = this.state.entries.find((e) => e.bundle.members.some((m) => m.id === prId) && !e.mergedPrIds.includes(prId));
		if (found === undefined) return undefined;

		const mergedPrIds = [...found.mergedPrIds, prId];
		// A live deep-investigation session tied to exactly this PR is moot now — the human
		// resolved it by merging directly rather than through the session's eventual proposal.
		// Marking it "rejected" (the same terminal state rejectInvestigation uses) keeps it
		// from being silently orphaned if the entry's status moves off "investigating" below,
		// since pollInvestigationsLocked only ever polls that status.
		const investigations = found.investigations?.map((inv): FileInvestigation =>
			inv.prId === prId && (inv.status === "running" || inv.status === "awaitingReview") ? { ...inv, status: "rejected" } : inv,
		);
		const entry: MergeQueueEntry = investigations !== undefined ? { ...found, investigations } : found;
		// Strips abortedAt too (not just conflict), matching clearToQueued — otherwise a bundle
		// that lands here straight from "aborted" would keep a stale abortedAt on a "landed"
		// entry, contradicting that field's "set only when status is aborted" contract.
		const { conflict: _conflict, abortedAt: _abortedAt, ...rest } = entry;

		if (entry.bundle.members.every((m) => mergedPrIds.includes(m.id))) {
			const landed: MergeQueueEntry = { ...rest, mergedPrIds, status: "landed", landedAt: new Date().toISOString() };
			await this.setEntry(entry.bundleId, landed);
			return landed;
		}

		// Other members are still pending. Only clear "conflict"/"investigating" back to
		// "queued" when the externally merged PR is the exact one that was blocking — same
		// matching reattemptForPr makes for a synchronize push. An unrelated still-pending
		// member merging shouldn't discard a currently-valid conflict/investigation recorded
		// against a different PR. Leave "landing" alone (a resume is already in flight;
		// dequeueNext's per-member mergedPrIds.includes skip already handles it) and "aborted"
		// alone (an explicit human give-up, same exclusion reattemptForPr already makes for a
		// stray push).
		const blockedOnThisPr =
			(entry.status === "conflict" && entry.conflict?.prId === prId) ||
			(entry.status === "investigating" &&
				found.investigations?.some((inv) => inv.prId === prId && (inv.status === "running" || inv.status === "awaitingReview")) === true);
		const updated: MergeQueueEntry = {
			...(blockedOnThisPr ? rest : entry),
			mergedPrIds,
			status: blockedOnThisPr ? "queued" : entry.status,
		};
		await this.setEntry(entry.bundleId, updated);
		return updated;
	}

	// A human gave up waiting on a bundle stuck mid-landing (possibly with some members
	// already merged) or blocked on conflict — moves it to a terminal "aborted" state so it
	// stops being retried by dequeueNext()/reattempt(). Does not revert mergedPrIds (INV-4:
	// that's a separate, explicit per-PR action via revertPr) and does not delete the entry
	// (residual stays visible per INV-6, same as every other non-queued exit path). "queued"
	// entries use removeQueued() instead; "landed" and already-"aborted" entries have nothing
	// to abort.
	async abort(bundleId: string): Promise<MergeQueueEntry | undefined> {
		return this.withLock(() => this.abortLocked(bundleId));
	}

	private async abortLocked(bundleId: string): Promise<MergeQueueEntry | undefined> {
		const entry = this.state.entries.find((e) => e.bundleId === bundleId && (e.status === "landing" || e.status === "conflict"));
		if (entry === undefined) return undefined;
		const { conflict: _conflict, ...rest } = entry;
		const aborted: MergeQueueEntry = { ...rest, status: "aborted", abortedAt: new Date().toISOString() };
		await this.setEntry(bundleId, aborted);
		// Audit trail, matching logConflictResolution()'s call at every other conflict-adjacent
		// transition — only when there's a specific prId to attribute it to; a "landing" abort
		// with no conflict recorded yet isn't blocked on a particular PR.
		if (entry.conflict !== undefined) {
			await logConflictResolution(this.conflictLogPath, bundleId, entry.conflict.prId, "unresolved", "aborted by user");
		}
		return aborted;
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
	// dequeueNext()/reattempt() for however long a pass over every queued PR takes, and a
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

	// Periodic check (meant to be wired into a setInterval, like refreshQueuedBranches) for
	// bundles with an in-flight investigation session. Goes through withLock, unlike
	// refreshQueuedBranches, because — unlike that read-only pass — this one mutates
	// `this.state` (recording decision packets, flipping status back to "conflict").
	async pollInvestigations(): Promise<void> {
		return this.withLock(() => this.pollInvestigationsLocked());
	}

	private async pollInvestigationsLocked(): Promise<void> {
		const client = this.deepInvestigation?.getClient();
		if (client === undefined) return;

		const investigating = this.state.entries.filter((e) => e.status === "investigating");
		for (const entry of investigating) {
			const investigations = entry.investigations ?? [];
			let changed = false;
			const updated = await Promise.all(
				investigations.map(async (inv): Promise<FileInvestigation> => {
					if (inv.status !== "running") return inv;
					let result;
					try {
						result = await pollInvestigationSession(client, inv.sessionId);
					} catch (err) {
						console.error(`Polling investigation session ${inv.sessionId} failed:`, err);
						return inv;
					}
					if (!result.done) return inv;
					changed = true;
					if (result.packet !== undefined) {
						return { ...inv, status: "awaitingReview", decisionPacket: result.packet };
					}
					return { ...inv, status: "failed", failureReason: result.reason };
				}),
			);
			if (!changed) continue;
			// Every investigation for this entry has a terminal outcome now (or already did) —
			// fall back to "conflict" so the entry re-enters the normal disclosure/retry path,
			// carrying the decision packets for a human to accept/reject.
			const stillRunning = updated.some((inv) => inv.status === "running");
			const nextStatus: MergeQueueEntryStatus = stillRunning ? "investigating" : "conflict";
			await this.setEntry(entry.bundleId, { ...entry, status: nextStatus, investigations: updated });
		}
	}

	// Applies a decision packet's proposed resolution through the existing
	// commitResolvedFiles/ResolvedFile pipeline (Quire re-applies the text itself rather than
	// trusting a write the agent made) and requeues the bundle so the next dequeueNext() picks
	// up the merge from there. Only valid on a "conflict" entry with a matching
	// "awaitingReview" investigation — mirrors reattempt()'s status guard.
	async acceptInvestigation(bundleId: string, path: string): Promise<MergeQueueEntry | undefined> {
		return this.withLock(() => this.acceptInvestigationLocked(bundleId, path));
	}

	private async acceptInvestigationLocked(bundleId: string, path: string): Promise<MergeQueueEntry | undefined> {
		const entry = this.state.entries.find((e) => e.bundleId === bundleId && e.status === "conflict");
		if (entry === undefined) return undefined;
		const investigations = entry.investigations ?? [];
		const investigation = investigations.find((i) => i.path === path && i.status === "awaitingReview");
		if (investigation === undefined || investigation.decisionPacket === undefined) return undefined;
		const pr = entry.bundle.members.find((m) => m.id === investigation.prId);
		if (pr === undefined) throw new Error(`PR ${investigation.prId} not found in bundle ${bundleId}`);

		const mergeability = await this.github.getMergeability(pr.repoOwner, pr.repoName, pr.number);
		// Mode is not tracked on FileInvestigation (a decision packet only carries file
		// content) — "100644" (non-executable text) covers every case this tier targets, since
		// escalation only ever fires on a text-hunk merge conflict, never a mode conflict.
		await this.github.commitResolvedFiles(pr.repoOwner, pr.repoName, pr.number, mergeability.baseSha, [
			{ path: investigation.path, content: investigation.decisionPacket.proposedResolution, mode: "100644" },
		]);

		const updatedInvestigations = investigations.map((i) => (i === investigation ? { ...i, status: "accepted" as const } : i));
		const { conflict: _conflict, ...rest } = entry;
		const requeued: MergeQueueEntry = { ...rest, status: "queued", investigations: updatedInvestigations };
		await this.setEntry(bundleId, requeued);
		return requeued;
	}

	// Leaves the bundle exactly as "conflict" — clearing the packet is enough for it to stop
	// being offered for review; the underlying conflict is untouched and still needs either a
	// manual fix or another retry.
	async rejectInvestigation(bundleId: string, path: string): Promise<MergeQueueEntry | undefined> {
		return this.withLock(() => this.rejectInvestigationLocked(bundleId, path));
	}

	private async rejectInvestigationLocked(bundleId: string, path: string): Promise<MergeQueueEntry | undefined> {
		const entry = this.state.entries.find((e) => e.bundleId === bundleId && e.status === "conflict");
		if (entry === undefined) return undefined;
		const investigations = entry.investigations ?? [];
		const investigation = investigations.find((i) => i.path === path && i.status === "awaitingReview");
		if (investigation === undefined) return undefined;
		const updated: MergeQueueEntry = {
			...entry,
			investigations: investigations.map((i) => (i === investigation ? { ...i, status: "rejected" as const } : i)),
		};
		await this.setEntry(bundleId, updated);
		return updated;
	}
}
