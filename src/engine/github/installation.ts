import { rm } from "node:fs/promises";
import { readJsonFile, writeSecretFileAtomic } from "../jsonFile.js";

export interface InstallationBinding {
	installationId: number;
	// The GitHub user or org login the installation is attached to — informational/display
	// only ("Connected to the `acme-corp` organization"), never used to construct API calls
	// (installationId alone is what's passed to @octokit/auth-app).
	accountLogin: string;
	accountType: "User" | "Organization";
	boundAt: string;
}

// A repo a team has added to its watch list — not "the" selected repo, since a team can
// watch several concurrently (see accountState.ts's installationForRepo/repoBinding).
// Settings live here, per-repo, rather than on InstallationAccountState as a whole: a team
// reasonably wants auto-merge on for a low-stakes repo and off for a critical one.
export interface RepoBinding {
	owner: string;
	name: string;
	// Which bound installation this repo was added through — resolved once at add time
	// rather than re-derived on every use, since it's the only cheap way to know which
	// installation's client backs this repo's watch loop without an extra API round-trip.
	installationId: number;
	// Opt-in override of INV-5: when true, accept merges immediately instead of enqueuing.
	autoMergeOnAccept?: boolean;
	// Opt-in: post an unresolved merge conflict's detail as a plain PR comment for an
	// external agent fleet to pick up.
	flagConflictsForFleet?: boolean;
	// Opt-in: escalate an unresolved conflict to a Managed Agents investigation.
	enableDeepConflictInvestigation?: boolean;
	addedAt: string;
	addedBy: string; // login, audit only
}

// One team can bind several installations (their personal account plus N orgs) — this is
// the team-wide container persisted as a whole to installation.json.
export interface InstallationAccountState {
	installations: ReadonlyArray<InstallationBinding>;
	repos: ReadonlyArray<RepoBinding>;
}

function isInstallationBinding(value: unknown): value is InstallationBinding {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as Record<string, unknown>)["installationId"] === "number" &&
		typeof (value as Record<string, unknown>)["accountLogin"] === "string"
	);
}

function isRepoBinding(value: unknown): value is RepoBinding {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record["owner"] === "string" &&
		typeof record["name"] === "string" &&
		typeof record["installationId"] === "number" &&
		typeof record["addedAt"] === "string" &&
		typeof record["addedBy"] === "string" &&
		(record["autoMergeOnAccept"] === undefined || typeof record["autoMergeOnAccept"] === "boolean") &&
		(record["flagConflictsForFleet"] === undefined || typeof record["flagConflictsForFleet"] === "boolean") &&
		(record["enableDeepConflictInvestigation"] === undefined || typeof record["enableDeepConflictInvestigation"] === "boolean")
	);
}

// Still no migration from the oldest single-binding shape (an InstallationBinding at the
// top level, before "installations" was even an array) — that shape predates selectedRepo
// entirely and isn't distinguishable from noise worth guessing at.
function isInstallationAccountState(value: unknown): value is InstallationAccountState {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	if (!Array.isArray(record["installations"]) || !record["installations"].every(isInstallationBinding)) return false;
	if (!Array.isArray(record["repos"]) || !record["repos"].every(isRepoBinding)) return false;
	return true;
}

interface LegacySelectedRepo {
	owner: string;
	name: string;
	installationId: number;
}

function isLegacySelectedRepo(value: unknown): value is LegacySelectedRepo {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return typeof record["owner"] === "string" && typeof record["name"] === "string" && typeof record["installationId"] === "number";
}

// The pre-multi-repo shape: selectedRepo/autoMergeOnAccept/flagConflictsForFleet/
// enableDeepConflictInvestigation lived at the top level, before a team could watch more
// than one repo at once.
interface LegacyInstallationAccountState {
	installations: ReadonlyArray<InstallationBinding>;
	selectedRepo: LegacySelectedRepo;
	autoMergeOnAccept?: boolean;
	flagConflictsForFleet?: boolean;
	enableDeepConflictInvestigation?: boolean;
}

function isLegacyInstallationAccountState(value: unknown): value is LegacyInstallationAccountState {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	if (!Array.isArray(record["installations"]) || !record["installations"].every(isInstallationBinding)) return false;
	if (!isLegacySelectedRepo(record["selectedRepo"])) return false;
	return (
		(record["autoMergeOnAccept"] === undefined || typeof record["autoMergeOnAccept"] === "boolean") &&
		(record["flagConflictsForFleet"] === undefined || typeof record["flagConflictsForFleet"] === "boolean") &&
		(record["enableDeepConflictInvestigation"] === undefined || typeof record["enableDeepConflictInvestigation"] === "boolean")
	);
}

// Migrates in memory only, never writes back — same convention as
// util/jsonStatePersistence.ts's migrate-on-load, and deliberately so: loadInstallation is
// called from unlocked read paths (tenant.ts hydration, collaborators.ts) that don't hold
// installationLock.ts's per-team lock, so persisting here would race a concurrent
// /repos/select or /repos/remove write. The on-disk file naturally catches up to the new
// shape the next time any of those locked mutations save it.
//
// selectedRepo.installationId is dropped (repos comes back empty) rather than resurrected
// when it has no matching entry in installations: that only happens once the bound
// installation itself was removed/reinstalled, and fabricating a RepoBinding for an
// installation we can no longer back would resurface a repo /repos/select's own
// unknown-installation guard exists to reject.
function migrateLegacyInstallationAccountState(legacy: LegacyInstallationAccountState): InstallationAccountState {
	const boundInstallation = legacy.installations.find((binding) => binding.installationId === legacy.selectedRepo.installationId);
	if (boundInstallation === undefined) {
		console.warn(
			`migrateLegacyInstallationAccountState: dropping stale selectedRepo ${legacy.selectedRepo.owner}/${legacy.selectedRepo.name} — its installationId ${legacy.selectedRepo.installationId} has no matching binding`,
		);
		return { installations: legacy.installations, repos: [] };
	}

	const repo: RepoBinding = {
		owner: legacy.selectedRepo.owner,
		name: legacy.selectedRepo.name,
		installationId: legacy.selectedRepo.installationId,
		...(legacy.autoMergeOnAccept !== undefined ? { autoMergeOnAccept: legacy.autoMergeOnAccept } : {}),
		...(legacy.flagConflictsForFleet !== undefined ? { flagConflictsForFleet: legacy.flagConflictsForFleet } : {}),
		...(legacy.enableDeepConflictInvestigation !== undefined
			? { enableDeepConflictInvestigation: legacy.enableDeepConflictInvestigation }
			: {}),
		addedAt: boundInstallation.boundAt,
		addedBy: "migration",
	};
	return { installations: legacy.installations, repos: [repo] };
}

type PersistedInstallationState = InstallationAccountState | LegacyInstallationAccountState;

function isPersistedInstallationState(value: unknown): value is PersistedInstallationState {
	return isInstallationAccountState(value) || isLegacyInstallationAccountState(value);
}

export async function loadInstallation(path: string): Promise<InstallationAccountState | undefined> {
	const state = await readJsonFile(path, isPersistedInstallationState);
	if (state === undefined) return undefined;
	return isInstallationAccountState(state) ? state : migrateLegacyInstallationAccountState(state);
}

export async function saveInstallation(path: string, state: InstallationAccountState): Promise<void> {
	// Written 0600 (not the default 0644): this holds no credential itself, but it enumerates
	// which orgs/installation ids a team is connected to — exactly the small, guessable integers
	// an installation-hijack attempt needs (see the /install/callback access check). Keep it out
	// of reach of other local users / backups on a shared host, same as the token files.
	await writeSecretFileAtomic(path, state);
}

export async function clearInstallation(path: string): Promise<void> {
	await rm(path, { force: true });
}
