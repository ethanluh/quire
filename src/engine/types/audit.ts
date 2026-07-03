import type { PullRequest } from "./core.js";

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

export interface AuditState {
	entries: ReadonlyArray<AuditEntry>;
}
