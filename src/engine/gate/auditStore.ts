import type { PullRequest } from "../types/core.js";
import { appendNdjson, readNdjson, truncateNdjson } from "../instrumentation/store.js";

export interface AuditEntry {
	pr: PullRequest;
	criterionName: string;
	reason: string;
	addedAt: string;
}

export class AuditStore {
	private readonly entries: AuditEntry[];

	constructor(
		private readonly logPath?: string,
		initialEntries: ReadonlyArray<AuditEntry> = [],
	) {
		this.entries = [...initialEntries];
	}

	// Persist before mutating in-memory state, so a failed write never leaves the
	// in-memory store ahead of the log — list() must never report something a
	// restart (loadAuditStore) couldn't reproduce.
	async add(pr: PullRequest, criterionName: string, reason: string): Promise<void> {
		const entry: AuditEntry = { pr, criterionName, reason, addedAt: new Date().toISOString() };
		if (this.logPath !== undefined) await appendNdjson(this.logPath, entry);
		this.entries.push(entry);
	}

	list(): ReadonlyArray<AuditEntry> {
		return this.entries;
	}

	async clear(): Promise<void> {
		if (this.logPath !== undefined) await truncateNdjson(this.logPath);
		this.entries.length = 0;
	}
}

// Re-instantiates a store from its persisted NDJSON log (if any), so shadow-mode
// audit history survives a process restart instead of resetting to empty (INV-6).
export async function loadAuditStore(logPath?: string): Promise<AuditStore> {
	if (logPath === undefined) return new AuditStore();
	const entries = await readNdjson<AuditEntry>(logPath);
	return new AuditStore(logPath, entries);
}
