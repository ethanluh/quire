import type { LlmProvider } from "../../engine/drift/effectList/provider.js";
import { resolveLlmProvider } from "./resolveLlmProvider.js";
import type { LlmProviderEnv } from "./resolveLlmProvider.js";

export interface JudgeProviderEnv extends LlmProviderEnv {
	// Overrides ANTHROPIC_MODEL/GEMINI_MODEL for the judge specifically, reusing whichever
	// account (default or judge-specific below) ends up resolving. Set alone (no dedicated
	// judge key), this still counts as an explicit bias-mitigation attempt — a different
	// model checkpoint is enough to avoid the same model instance judging its own PR, even
	// on the same vendor account.
	QUIRE_JUDGE_MODEL?: string;
	// Full account independence: a separate vendor/key entirely, for teams that want the
	// judge on its own billing/account rather than just a different model on the shared one.
	QUIRE_JUDGE_LLM_PROVIDER?: string;
	QUIRE_JUDGE_ANTHROPIC_API_KEY?: string;
	QUIRE_JUDGE_GEMINI_API_KEY?: string;
}

export interface ResolvedJudgeProvider {
	provider: LlmProvider;
	description: string;
	// False whenever the judge ends up on the exact same model as the shared pipeline
	// provider — whether because nothing judge-specific was configured at all, or because
	// what was configured happened to resolve to an identical modelKey anyway. Callers
	// (tenant.ts, Phase 3) should surface this in their startup log; bundleJudge.ts doesn't
	// need it — it just uses whichever provider it's handed.
	biasMitigationActive: boolean;
}

function hasAnyJudgeOverride(env: JudgeProviderEnv): boolean {
	return (
		(env.QUIRE_JUDGE_MODEL ?? "") !== "" ||
		(env.QUIRE_JUDGE_LLM_PROVIDER ?? "") !== "" ||
		(env.QUIRE_JUDGE_ANTHROPIC_API_KEY ?? "") !== "" ||
		(env.QUIRE_JUDGE_GEMINI_API_KEY ?? "") !== ""
	);
}

// A judge-specific key, when given, always wins over reusing the shared one — but a model
// override with no dedicated key still needs *some* key to call the API with, so it falls
// back to the shared account's own key rather than resolving to nothing.
function judgeEnvView(env: JudgeProviderEnv): LlmProviderEnv {
	const llmProvider = env.QUIRE_JUDGE_LLM_PROVIDER;
	const anthropicApiKey = env.QUIRE_JUDGE_ANTHROPIC_API_KEY ?? env.ANTHROPIC_API_KEY;
	const anthropicBaseUrl = env.ANTHROPIC_BASE_URL;
	const anthropicModel = env.QUIRE_JUDGE_MODEL ?? env.ANTHROPIC_MODEL;
	const geminiApiKey = env.QUIRE_JUDGE_GEMINI_API_KEY ?? env.GEMINI_API_KEY;
	const geminiModel = env.QUIRE_JUDGE_MODEL ?? env.GEMINI_MODEL;
	return {
		...(llmProvider !== undefined ? { LLM_PROVIDER: llmProvider } : {}),
		...(anthropicApiKey !== undefined ? { ANTHROPIC_API_KEY: anthropicApiKey } : {}),
		...(anthropicBaseUrl !== undefined ? { ANTHROPIC_BASE_URL: anthropicBaseUrl } : {}),
		...(anthropicModel !== undefined ? { ANTHROPIC_MODEL: anthropicModel } : {}),
		...(geminiApiKey !== undefined ? { GEMINI_API_KEY: geminiApiKey } : {}),
		...(geminiModel !== undefined ? { GEMINI_MODEL: geminiModel } : {}),
	};
}

// "Never let the same model instance that generated a PR judge that PR" (mission constraint)
// — resolved here as "never let the judge silently run on the identical model/account the
// rest of the pipeline (drift extraction, conflict resolution) already uses, without at
// least logging that bias mitigation is off." Mirrors resolveLlmProvider.ts's own shape and
// precedence rules exactly, just namespaced under QUIRE_JUDGE_*, and falls back to the
// already-resolved shared provider (never a fresh stub) when nothing judge-specific is set —
// a judge with zero config should behave identically to today (no judge at all), not spin up
// its own independent stub.
export function resolveJudgeProvider(env: JudgeProviderEnv, sharedProvider: LlmProvider): ResolvedJudgeProvider {
	if (!hasAnyJudgeOverride(env)) {
		return {
			provider: sharedProvider,
			description: `${sharedProvider.modelKey} (shared with the rest of the pipeline — bias mitigation OFF)`,
			biasMitigationActive: false,
		};
	}

	const resolved = resolveLlmProvider(judgeEnvView(env));
	const biasMitigationActive = resolved.provider.modelKey !== sharedProvider.modelKey;
	return {
		provider: resolved.provider,
		description: biasMitigationActive ? resolved.description : `${resolved.description} (bias mitigation OFF — same model as the shared pipeline)`,
		biasMitigationActive,
	};
}
