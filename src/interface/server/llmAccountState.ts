import type { ConnectedLlmAccount } from "../../engine/llm/account.js";

// Lifts the connected LLM account's metadata out of llmAccountRouter's private closure so
// GET /status can report it without re-reading the file on every request. Mirrors
// accountState.ts's role for the GitHub account.
export interface LlmAccountState {
	current: ConnectedLlmAccount | undefined;
}

export function createLlmAccountState(initial: ConnectedLlmAccount | undefined): LlmAccountState {
	return { current: initial };
}
