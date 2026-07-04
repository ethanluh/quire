import { readJsonFile, writeJsonFileAtomic } from "../jsonFile.js";
import { createKeyedLock } from "./keyedLock.js";

// Persists best-effort GitHub-collaborator-sync failures so an owner/admin has something
// queryable beyond a server log line (see team.ts's logCollaboratorSyncResults) — the sync
// itself stays fire-and-forget and best-effort; this only stops discarding its result. Keyed
// by (login, owner, name, action) so a later successful retry (a rejoin, a role change, a
// re-approved permission) clears the matching entry instead of it lingering forever.
export interface CollaboratorSyncIssue {
	login: string;
	owner: string;
	name: string;
	action: "add" | "remove";
	reason: "insufficient-permission" | "github-error";
	message: string;
	occurredAt: string;
}

// Caps how many unresolved issues one team's file can accumulate — a rotating window of the
// most recent failures, not an unbounded audit log (teamStore's invites.json already covers
// long-lived audit-style records; this is closer to a dashboard's "current problems" list).
const MAX_ISSUES = 50;

function isCollaboratorSyncIssue(value: unknown): value is CollaboratorSyncIssue {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record["login"] === "string" &&
		typeof record["owner"] === "string" &&
		typeof record["name"] === "string" &&
		(record["action"] === "add" || record["action"] === "remove") &&
		(record["reason"] === "insufficient-permission" || record["reason"] === "github-error") &&
		typeof record["message"] === "string" &&
		typeof record["occurredAt"] === "string"
	);
}

function isCollaboratorSyncIssueList(value: unknown): value is ReadonlyArray<CollaboratorSyncIssue> {
	return Array.isArray(value) && value.every(isCollaboratorSyncIssue);
}

// Per-path promise chaining, same pattern teamStore.ts's withTeamLock uses — needed since
// several fire-and-forget syncs for the same team can otherwise race a load-modify-save of
// this same file into a lost update.
const withLock = createKeyedLock();

export async function listCollaboratorSyncIssues(path: string): Promise<ReadonlyArray<CollaboratorSyncIssue>> {
	return (await readJsonFile(path, isCollaboratorSyncIssueList)) ?? [];
}

function sameKey(a: CollaboratorSyncIssue, login: string, owner: string, name: string, action: "add" | "remove"): boolean {
	return a.login === login && a.owner === owner && a.name === name && a.action === action;
}

// Records a failure, replacing any prior unresolved entry for the same (login, owner, name,
// action) rather than accumulating one row per retry.
export async function recordCollaboratorSyncFailure(path: string, issue: CollaboratorSyncIssue): Promise<void> {
	return withLock(path, async () => {
		const existing = await listCollaboratorSyncIssues(path);
		const withoutSameKey = existing.filter((i) => !sameKey(i, issue.login, issue.owner, issue.name, issue.action));
		const updated = [...withoutSameKey, issue].slice(-MAX_ISSUES);
		await writeJsonFileAtomic(path, updated);
	});
}

// Clears a since-resolved issue (a later successful add/remove for the same key) so it stops
// showing up as an outstanding problem. A no-op write is skipped when there was nothing to
// clear, so a successful sync on a team that never had any recorded issues doesn't touch disk.
export async function clearCollaboratorSyncIssue(
	path: string,
	login: string,
	owner: string,
	name: string,
	action: "add" | "remove",
): Promise<void> {
	return withLock(path, async () => {
		const existing = await listCollaboratorSyncIssues(path);
		const updated = existing.filter((i) => !sameKey(i, login, owner, name, action));
		if (updated.length !== existing.length) await writeJsonFileAtomic(path, updated);
	});
}
