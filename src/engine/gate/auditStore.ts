import { randomUUID } from "node:crypto";
import type { PullRequest } from "../types/core.js";
import { readNdjson, truncateNdjson, writeNdjson } from "../instrumentation/store.js";

export interface AuditEntry {
	id: string;
	pr: PullRequest;
	criterionName: string;
	reason: string;
	addedAt: string;
	// null until a human reviews the audit view and marks the flag wrong. Feeds the
	// per-criterion false-positive rate (gate health, §12 of the engineering handoff;
	// docs/instrumentation.md, "Gate decisions").
	overturnedAt: string | null;
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
	// restart (loadAuditStore) couldn't reproduce. Persisting rewrites the whole log
	// (see writeNdjson) rather than appending, since overturn() below needs to mutate
	// an existing row and NDJSON has no in-place update — add() uses the same
	// full-rewrite path so both methods keep the log in one consistent format.
	async add(pr: PullRequest, criterionName: string, reason: string): Promise<void> {
		const entry: AuditEntry = {
			id: randomUUID(),
			pr,
			criterionName,
			reason,
			addedAt: new Date().toISOString(),
			overturnedAt: null,
		};
		const next = [...this.entries, entry];
		if (this.logPath !== undefined) await writeNdjson(this.logPath, next);
		this.entries.push(entry);
	}

	list(): ReadonlyArray<AuditEntry> {
		return this.entries;
	}

	// Records a human's judgment that a shadow-mode flag was wrong. Returns false if
	// entryId doesn't match any entry. Idempotent: overturning an already-overturned
	// entry succeeds without changing its overturnedAt, so a double-click can't error.
	async overturn(entryId: string): Promise<boolean> {
		const existing = this.entries.find((entry) => entry.id === entryId);
		if (existing === undefined) return false;
		if (existing.overturnedAt !== null) return true;

		const overturned: AuditEntry = { ...existing, overturnedAt: new Date().toISOString() };
		const next = this.entries.map((entry) => (entry.id === entryId ? overturned : entry));
		if (this.logPath !== undefined) await writeNdjson(this.logPath, next);
		existing.overturnedAt = overturned.overturnedAt;
		return true;
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
