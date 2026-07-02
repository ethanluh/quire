import type { LlmProvider } from "../../engine/drift/effectList/provider.js";
import { StubLlmProvider } from "../../engine/drift/effectList/stubProvider.js";
import { AnthropicLlmProvider, DEFAULT_MODEL as DEFAULT_ANTHROPIC_MODEL } from "../../engine/drift/effectList/anthropicProvider.js";
import { GeminiLlmProvider, DEFAULT_MODEL as DEFAULT_GEMINI_MODEL } from "../../engine/drift/effectList/geminiProvider.js";
import type { ConnectedLlmAccount } from "../../engine/llm/account.js";

export interface LlmProviderEnv {
	ANTHROPIC_API_KEY?: string;
	ANTHROPIC_BASE_URL?: string;
	ANTHROPIC_MODEL?: string;
	GEMINI_API_KEY?: string;
	GEMINI_MODEL?: string;
	LLM_PROVIDER?: string;
}

export interface ResolvedLlmProvider {
	provider: LlmProvider;
	description: string;
}

function nonEmpty(value: string | undefined): string | undefined {
	return value === undefined || value === "" ? undefined : value;
}

// LLM-backed steps sit behind the LlmProvider interface so the backing model is
// swappable: LLM_PROVIDER picks explicitly (and an unrecognized value is a hard
// error, not a silent stub fallback); otherwise Anthropic takes priority over
// Gemini when both keys are present; with neither key set, falls back to the stub.
export function resolveLlmProvider(env: LlmProviderEnv): ResolvedLlmProvider {
	const anthropicApiKey = nonEmpty(env.ANTHROPIC_API_KEY);
	const geminiApiKey = nonEmpty(env.GEMINI_API_KEY);
	const requested = nonEmpty(env.LLM_PROVIDER);

	const name = requested ?? (anthropicApiKey !== undefined ? "anthropic" : geminiApiKey !== undefined ? "gemini" : "stub");

	switch (name) {
		case "anthropic": {
			if (anthropicApiKey === undefined) {
				throw new Error("LLM_PROVIDER=anthropic requires ANTHROPIC_API_KEY to be set");
			}
			const model = nonEmpty(env.ANTHROPIC_MODEL);
			const baseUrl = nonEmpty(env.ANTHROPIC_BASE_URL);
			return {
				provider: new AnthropicLlmProvider({
					apiKey: anthropicApiKey,
					...(baseUrl !== undefined ? { baseUrl } : {}),
					...(model !== undefined ? { model } : {}),
				}),
				description: `anthropic (${model ?? DEFAULT_ANTHROPIC_MODEL})`,
			};
		}
		case "gemini": {
			if (geminiApiKey === undefined) {
				throw new Error("LLM_PROVIDER=gemini requires GEMINI_API_KEY to be set");
			}
			const model = nonEmpty(env.GEMINI_MODEL);
			return {
				provider: new GeminiLlmProvider({ apiKey: geminiApiKey, ...(model !== undefined ? { model } : {}) }),
				description: `gemini (${model ?? DEFAULT_GEMINI_MODEL})`,
			};
		}
		case "stub":
			return { provider: new StubLlmProvider(), description: "stub (no ANTHROPIC_API_KEY / GEMINI_API_KEY set)" };
		default:
			throw new Error(`Unknown LLM_PROVIDER "${requested}" (expected "anthropic" or "gemini")`);
	}
}

// An account connected through the UI (llmAccountRouter) takes priority over env-based
// resolution — see index.ts's precedence comment for the equivalent GitHub account choice.
// Shared by server startup and the connect route so provider-construction logic for a
// given (provider, apiKey) pair lives in exactly one place.
export function buildLlmProviderFromAccount(account: ConnectedLlmAccount): ResolvedLlmProvider {
	switch (account.provider) {
		case "anthropic":
			return {
				provider: new AnthropicLlmProvider({ apiKey: account.apiKey }),
				description: `anthropic (${DEFAULT_ANTHROPIC_MODEL}, connected via UI)`,
			};
		case "gemini":
			return {
				provider: new GeminiLlmProvider({ apiKey: account.apiKey }),
				description: `gemini (${DEFAULT_GEMINI_MODEL}, connected via UI)`,
			};
	}
}
