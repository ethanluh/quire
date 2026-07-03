import { readJsonFile, writeJsonFileAtomic } from "../jsonFile.js";
import type { SelectedRepo } from "./installation.js";

// Split out from InstallationBinding: these are the parts of "being connected to GitHub"
// that represent user intent (which repo, whether to auto-merge) rather than the connection
// itself (installationId, accountLogin, boundAt). Disconnect clears the latter but must never
// clear the former — see installation.ts's clearInstallation and githubApp.ts's /disconnect.
export interface StoredPreferences {
	selectedRepo?: SelectedRepo;
	autoMergeOnAccept?: boolean;
}

function isStoredPreferences(value: unknown): value is StoredPreferences {
	return typeof value === "object" && value !== null;
}

export async function loadPreferences(path: string): Promise<StoredPreferences> {
	return (await readJsonFile(path, isStoredPreferences)) ?? {};
}

export async function savePreferences(path: string, preferences: StoredPreferences): Promise<void> {
	await writeJsonFileAtomic(path, preferences);
}
