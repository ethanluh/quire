import { rm } from "node:fs/promises";
import { readJsonFile, writeJsonFileAtomic } from "../jsonFile.js";

export interface SelectedRepo {
	owner: string;
	name: string;
	// No webhookId: a GitHub App's webhook is registered once, instance-wide, on the App's
	// own settings page — there is nothing per-repo to create/delete/track here.
}

export interface InstallationBinding {
	installationId: number;
	// The GitHub user or org login the installation is attached to — informational/display
	// only ("Connected to the `acme-corp` organization"), never used to construct API calls
	// (installationId alone is what's passed to @octokit/auth-app).
	accountLogin: string;
	accountType: "User" | "Organization";
	selectedRepo?: SelectedRepo;
	boundAt: string;
	// Opt-in override of INV-5: when true, accept merges immediately instead of enqueuing.
	autoMergeOnAccept?: boolean;
}

function isInstallationBinding(value: unknown): value is InstallationBinding {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as Record<string, unknown>)["installationId"] === "number" &&
		typeof (value as Record<string, unknown>)["accountLogin"] === "string"
	);
}

export async function loadInstallation(path: string): Promise<InstallationBinding | undefined> {
	return readJsonFile(path, isInstallationBinding);
}

export async function saveInstallation(path: string, binding: InstallationBinding): Promise<void> {
	await writeJsonFileAtomic(path, binding);
}

export async function clearInstallation(path: string): Promise<void> {
	await rm(path, { force: true });
}
