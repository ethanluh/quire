import type { Bundle } from "../types/core.js";
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

	async enqueue(bundle: Bundle): Promise<void> {
		const entry: MergeQueueEntry = {
			bundleId: bundle.id,
			bundle,
			enqueuedAt: new Date().toISOString(),
			status: "queued",
			revertedPrIds: [],
		};
		this.state = { entries: [...this.state.entries, entry] };
		await this.persist();
	}

	async dequeueNext(): Promise<MergeQueueEntry | undefined> {
		const idx = this.state.entries.findIndex((e) => e.status === "queued");
		if (idx < 0) return undefined;

		const entry = this.state.entries[idx]!;
		const updated: MergeQueueEntry = { ...entry, status: "landing" };
		this.state = {
			entries: this.state.entries.map((e, i) => (i === idx ? updated : e)),
		};
		await this.persist();

		// Merge each member PR
		for (const pr of entry.bundle.members) {
			await this.github.mergePullRequest(pr.repoOwner, pr.repoName, pr.number);
		}

		const landed: MergeQueueEntry = { ...updated, status: "landed" };
		this.state = {
			entries: this.state.entries.map((e) => (e.bundleId === entry.bundleId ? landed : e)),
		};
		await this.persist();
		return landed;
	}

	async revertPr(bundleId: string, prId: string): Promise<string> {
		const entry = this.state.entries.find((e) => e.bundleId === bundleId);
		if (entry === undefined) throw new Error(`Bundle ${bundleId} not found in queue`);

		const pr = entry.bundle.members.find((m) => m.id === prId);
		if (pr === undefined) throw new Error(`PR ${prId} not found in bundle ${bundleId}`);

		const revertUrl = await this.github.revertPullRequest(pr.repoOwner, pr.repoName, pr.number);

		const updated: MergeQueueEntry = {
			...entry,
			revertedPrIds: [...entry.revertedPrIds, prId],
		};
		this.state = {
			entries: this.state.entries.map((e) => (e.bundleId === bundleId ? updated : e)),
		};
		await this.persist();
		return revertUrl;
	}

	async listEntries(): Promise<ReadonlyArray<MergeQueueEntry>> {
		return this.state.entries;
	}

	async getEntry(bundleId: string): Promise<MergeQueueEntry | undefined> {
		return this.state.entries.find((e) => e.bundleId === bundleId);
	}

	async removeQueued(bundleId: string): Promise<void> {
		const entry = this.state.entries.find((e) => e.bundleId === bundleId && e.status === "queued");
		if (entry === undefined) return;
		this.state = { entries: this.state.entries.filter((e) => e.bundleId !== bundleId) };
		await this.persist();
	}
}
