import type { ConnectedAccount } from "../../engine/github/account.js";

// Lifts the connected account out of githubAccountRouter's private closure so the webhook
// route and reconciliation poll — both constructed in index.ts, outside that router — can
// read the live account (selected repo, tokens) without a second source of truth.
export interface AccountState {
	current: ConnectedAccount | undefined;
}

export function createAccountState(initial: ConnectedAccount | undefined): AccountState {
	return { current: initial };
}
