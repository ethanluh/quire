import type { InstallationBinding } from "../../engine/github/installation.js";
import type { StoredPreferences } from "../../engine/github/preferences.js";

// Lifts the installation binding out of githubApp.ts's private closure so the webhook
// route and reconciliation poll — both constructed in index.ts, outside that router — can
// read the live binding (selected repo, installationId) without a second source of truth.
//
// `preferences` is deliberately separate from `current`: it survives disconnect/reconnect
// (see preferences.ts), while `current` is undefined whenever there's no active installation.
export interface AccountState {
	current: InstallationBinding | undefined;
	preferences: StoredPreferences;
}

// Backfills selectedRepo/autoMergeOnAccept from `initial` whenever the caller's stored
// preferences don't already have them — the case for an installation bound before
// preferences.ts existed, where those fields still only live on the binding itself.
export function createAccountState(initial: InstallationBinding | undefined, preferences: StoredPreferences = {}): AccountState {
	const merged: StoredPreferences = {
		...preferences,
		...(preferences.selectedRepo === undefined && initial?.selectedRepo !== undefined ? { selectedRepo: initial.selectedRepo } : {}),
		...(preferences.autoMergeOnAccept === undefined && initial?.autoMergeOnAccept !== undefined
			? { autoMergeOnAccept: initial.autoMergeOnAccept }
			: {}),
	};
	return { current: initial, preferences: merged };
}
