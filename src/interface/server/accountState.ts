import type { InstallationBinding } from "../../engine/github/installation.js";

// Lifts the installation binding out of githubApp.ts's private closure so the webhook
// route and reconciliation poll — both constructed in index.ts, outside that router — can
// read the live binding (selected repo, installationId) without a second source of truth.
export interface AccountState {
	current: InstallationBinding | undefined;
}

export function createAccountState(initial: InstallationBinding | undefined): AccountState {
	return { current: initial };
}
