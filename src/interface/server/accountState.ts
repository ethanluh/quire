import type { InstallationAccountState, InstallationBinding } from "../../engine/github/installation.js";

// Lifts the installation state out of githubApp.ts's private closure so the webhook route
// and reconciliation poll — both constructed in index.ts, outside that router — can read
// the live state (bound installations, selected repo) without a second source of truth.
//
// selectedRepo/autoMergeOnAccept live on the always-present InstallationAccountState
// itself (never undefined, only `installations` can be empty), so they already survive
// individual installation disconnects/reconnects without a separate preferences store.
export interface AccountState {
	current: InstallationAccountState;
}

export function createAccountState(initial: InstallationAccountState | undefined): AccountState {
	return { current: initial ?? { installations: [] } };
}

// The installation that owns the currently selected repo — the only installation whose
// client/webhooks/reconciliation matter for the active watch loop. Undefined both when
// nothing is selected yet and when the selection's owning installation was since
// disconnected; callers already treat "no active binding" as one case either way.
export function activeInstallation(state: InstallationAccountState): InstallationBinding | undefined {
	if (state.selectedRepo === undefined) return undefined;
	return state.installations.find((i) => i.installationId === state.selectedRepo?.installationId);
}
