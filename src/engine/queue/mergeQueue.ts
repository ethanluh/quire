import type { Bundle, ReviewCard } from "../types/core.js";
import type { GitHubClient } from "../github/client.js";
import type { MergeQueueEntry, QueueState } from "../types/queue.js";
import { loadState, saveState } from "./persistence.js";

export class MergeQueue {
	private state: QueueState = { entries: [] };

	constructor(
		private readonly statePath: string,
		private readonly github: GitHubClient,
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
			await this.github.mergePullRequest(pr.repoOwner, pr.repoName, pr.number);
			entry = { ...entry, mergedPrIds: [...entry.mergedPrIds, pr.id] };
			await this.setEntry(entry.bundleId, entry);
		}

		const landed: MergeQueueEntry = { ...entry, status: "landed" };
		await this.setEntry(entry.bundleId, landed);
		return landed;
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

	async clear(): Promise<void> {
		this.state = { entries: [] };
		await this.persist();
	}
}
