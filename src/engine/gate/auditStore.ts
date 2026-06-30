import type { PullRequest } from "../types/core.js";

export interface AuditEntry {
	pr: PullRequest;
	criterionName: string;
	reason: string;
	addedAt: string;
}

export class AuditStore {
	private readonly entries: AuditEntry[] = [];

	add(pr: PullRequest, criterionName: string, reason: string): void {
		this.entries.push({ pr, criterionName, reason, addedAt: new Date().toISOString() });
	}

	list(): ReadonlyArray<AuditEntry> {
		return this.entries;
	}

	clear(): void {
		this.entries.length = 0;
	}
}
