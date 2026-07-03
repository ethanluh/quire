import { rm } from "node:fs/promises";
import { readJsonFile, writeJsonFileAtomic } from "../jsonFile.js";

export interface SelectedRepo {
	owner: string;
	name: string;
	// Which bound installation this repo was selected through — resolved once at select
	// time rather than re-derived on every use, since it's the only cheap way to know which
	// installation's client backs the active watch loop without an extra API round-trip.
	installationId: number;
}

export interface InstallationBinding {
	installationId: number;
	// The GitHub user or org login the installation is attached to — informational/display
	// only ("Connected to the `acme-corp` organization"), never used to construct API calls
	// (installationId alone is what's passed to @octokit/auth-app).
	accountLogin: string;
	accountType: "User" | "Organization";
	boundAt: string;
	// selectedRepo and autoMergeOnAccept live on InstallationAccountState, not here — they're
	// operator-wide preferences (which one repo to watch, whether to auto-merge), not
	// properties of any single installation.
}

// One signed-in operator can bind several installations (their personal account plus N
// orgs) — this is the account-wide container persisted as a whole to installation.json.
// Still no per-human-user isolation (each Quire instance has exactly one operator); this is
// purely "let one operator see repos across every installation they personally control."
export interface InstallationAccountState {
	installations: ReadonlyArray<InstallationBinding>;
	selectedRepo?: SelectedRepo;
	// Opt-in override of INV-5: when true, accept merges immediately instead of enqueuing.
	// Operator-wide rather than per-installation — an operator doesn't generally want
	// "auto-merge for org A but not org B."
	autoMergeOnAccept?: boolean;
	// Opt-in: post an unresolved merge conflict's detail as a plain PR comment for an
	// external agent fleet to pick up.
	flagConflictsForFleet?: boolean;
	// Opt-in: escalate an unresolved conflict to a Managed Agents investigation.
	enableDeepConflictInvestigation?: boolean;
}

function isInstallationBinding(value: unknown): value is InstallationBinding {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as Record<string, unknown>)["installationId"] === "number" &&
		typeof (value as Record<string, unknown>)["accountLogin"] === "string"
	);
}

function isSelectedRepo(value: unknown): value is SelectedRepo {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as Record<string, unknown>)["owner"] === "string" &&
		typeof (value as Record<string, unknown>)["name"] === "string" &&
		typeof (value as Record<string, unknown>)["installationId"] === "number"
	);
}

// No migration from the old single-binding shape: this is pre-production/dogfood state, so
// an old-format installation.json simply fails this guard and loads as "no installations" —
// the operator re-installs the GitHub App once. See PR description for this one-time step.
function isInstallationAccountState(value: unknown): value is InstallationAccountState {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	if (!Array.isArray(record["installations"]) || !record["installations"].every(isInstallationBinding)) return false;
	if (record["selectedRepo"] !== undefined && !isSelectedRepo(record["selectedRepo"])) return false;
	if (record["autoMergeOnAccept"] !== undefined && typeof record["autoMergeOnAccept"] !== "boolean") return false;
	if (record["flagConflictsForFleet"] !== undefined && typeof record["flagConflictsForFleet"] !== "boolean") return false;
	if (record["enableDeepConflictInvestigation"] !== undefined && typeof record["enableDeepConflictInvestigation"] !== "boolean") return false;
	return true;
}

export async function loadInstallation(path: string): Promise<InstallationAccountState | undefined> {
	return readJsonFile(path, isInstallationAccountState);
}

export async function saveInstallation(path: string, state: InstallationAccountState): Promise<void> {
	await writeJsonFileAtomic(path, state);
}

export async function clearInstallation(path: string): Promise<void> {
	await rm(path, { force: true });
}
