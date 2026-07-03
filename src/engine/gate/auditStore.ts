import { randomUUID } from "node:crypto";
import type { PullRequest } from "../types/core.js";
import type { AuditEntry } from "../types/audit.js";
import { loadState, saveState } from "./auditPersistence.js";

export type { AuditEntry } from "../types/audit.js";

export class AuditStore {
	private entries: ReadonlyArray<AuditEntry> = [];

	// Serializes every mutating call through one chain, so add()/overturn()/clear()
	// invoked from independent, concurrent callers (gate ingestion vs. the HTTP
	// overturn route both hold this same instance) never read-modify-write off a
	// stale snapshot of `entries` — same promise-chaining technique as
	// enqueueRefresh (src/interface/server/refreshRepoQueue.ts).
	private queue: Promise<unknown> = Promise.resolve();

	constructor(private readonly statePath?: string) {}

	private enqueue<T>(fn: () => Promise<T>): Promise<T> {
		const result = this.queue.then(fn, fn);
		this.queue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	async load(): Promise<void> {
		if (this.statePath === undefined) return;
		this.entries = (await loadState(this.statePath)).entries;
	}

	// Persist before mutating in-memory state, so a failed write never leaves the
	// in-memory store ahead of the log — list() must never report something a
	// restart (loadAuditStore) couldn't reproduce.
	async add(pr: PullRequest, criterionName: string, reason: string): Promise<void> {
		await this.enqueue(async () => {
			const entry: AuditEntry = {
				id: randomUUID(),
				pr,
				criterionName,
				reason,
				addedAt: new Date().toISOString(),
				overturnedAt: null,
			};
			const entries = [...this.entries, entry];
			if (this.statePath !== undefined) await saveState(this.statePath, { entries });
			this.entries = entries;
		});
	}

	list(): ReadonlyArray<AuditEntry> {
		return this.entries;
	}

	// Records a human's judgment that a shadow-mode flag was wrong. Returns false if
	// entryId doesn't match any entry. Idempotent: overturning an already-overturned
	// entry succeeds without changing its overturnedAt, so a double-click can't error.
	async overturn(entryId: string): Promise<boolean> {
		return this.enqueue(async () => {
			const existing = this.entries.find((entry) => entry.id === entryId);
			if (existing === undefined) return false;
			if (existing.overturnedAt !== null) return true;

			const overturnedAt = new Date().toISOString();
			const entries = this.entries.map((entry) => (entry.id === entryId ? { ...entry, overturnedAt } : entry));
			if (this.statePath !== undefined) await saveState(this.statePath, { entries });
			this.entries = entries;
			return true;
		});
	}

	async clear(): Promise<void> {
		await this.enqueue(async () => {
			if (this.statePath !== undefined) await saveState(this.statePath, { entries: [] });
			this.entries = [];
		});
	}
}

// Re-instantiates a store from its persisted state (if any), so shadow-mode audit
// history survives a process restart instead of resetting to empty (INV-6).
export async function loadAuditStore(statePath?: string): Promise<AuditStore> {
	const store = new AuditStore(statePath);
	await store.load();
	return store;
}
