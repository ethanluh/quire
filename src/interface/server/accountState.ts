import type { InstallationAccountState, InstallationBinding, RepoBinding } from "../../engine/github/installation.js";

// Lifts the installation state out of githubApp.ts's private closure so the webhook route
// and reconciliation poll — both constructed in index.ts, outside that router — can read
// the live state (bound installations, watched repos) without a second source of truth.
//
// repos lives on the always-present InstallationAccountState itself (never undefined, only
// `installations`/`repos` can be empty), so it already survives individual installation
// disconnects/reconnects without a separate preferences store.
export interface AccountState {
	current: InstallationAccountState;
}

export function createAccountState(initial: InstallationAccountState | undefined): AccountState {
	return { current: initial ?? { installations: [], repos: [] } };
}

// The specific RepoBinding for (owner, name), if the team is watching it — the settings
// (autoMergeOnAccept/flagConflictsForFleet/enableDeepConflictInvestigation) and the
// installationId backing it both live here now, per-repo rather than team-wide.
export function repoBinding(state: InstallationAccountState, owner: string, name: string): RepoBinding | undefined {
	return state.repos.find((r) => r.owner === owner && r.name === name);
}

// The installation that backs a specific watched repo. Undefined both when the repo isn't
// currently watched and when its owning installation was since disconnected; callers already
// treat "no active binding" as one case either way.
export function installationForRepo(state: InstallationAccountState, owner: string, name: string): InstallationBinding | undefined {
	const binding = repoBinding(state, owner, name);
	if (binding === undefined) return undefined;
	return state.installations.find((i) => i.installationId === binding.installationId);
}
