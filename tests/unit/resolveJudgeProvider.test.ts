import { describe, it, expect } from "@jest/globals";
import { resolveJudgeProvider } from "../../src/interface/server/resolveJudgeProvider.js";
import { AnthropicLlmProvider } from "../../src/engine/drift/effectList/anthropicProvider.js";
import { StubLlmProvider } from "../../src/engine/drift/effectList/stubProvider.js";

describe("resolveJudgeProvider", () => {
	it("falls back to the shared provider (not a fresh stub) when no judge-specific env is set", () => {
		const shared = new StubLlmProvider();
		const { provider, biasMitigationActive, description } = resolveJudgeProvider({}, shared);
		expect(provider).toBe(shared);
		expect(biasMitigationActive).toBe(false);
		expect(description).toContain("bias mitigation OFF");
	});

	it("builds a dedicated provider when a judge-specific model override is set, reusing the shared account's key", () => {
		const shared = new AnthropicLlmProvider({ apiKey: "sk-shared", model: "claude-haiku-4-5-20251001" });
		const { provider, biasMitigationActive } = resolveJudgeProvider(
			{ ANTHROPIC_API_KEY: "sk-shared", QUIRE_JUDGE_MODEL: "claude-opus-4-8" },
			shared,
		);
		expect(provider).toBeInstanceOf(AnthropicLlmProvider);
		expect(provider.modelKey).toBe("anthropic:claude-opus-4-8");
		expect(biasMitigationActive).toBe(true);
	});

	it("builds a fully independent provider when a judge-specific key and provider are both set", () => {
		const shared = new StubLlmProvider();
		const { provider, biasMitigationActive } = resolveJudgeProvider(
			{ QUIRE_JUDGE_LLM_PROVIDER: "anthropic", QUIRE_JUDGE_ANTHROPIC_API_KEY: "sk-judge-only" },
			shared,
		);
		expect(provider).toBeInstanceOf(AnthropicLlmProvider);
		expect(biasMitigationActive).toBe(true);
	});

	it("warns (bias mitigation OFF) when the judge override still resolves to the same modelKey as the shared provider", () => {
		const shared = new AnthropicLlmProvider({ apiKey: "sk-shared", model: "claude-haiku-4-5-20251001" });
		const { provider, biasMitigationActive, description } = resolveJudgeProvider(
			{ ANTHROPIC_API_KEY: "sk-shared", QUIRE_JUDGE_MODEL: "claude-haiku-4-5-20251001" },
			shared,
		);
		expect(provider.modelKey).toBe(shared.modelKey);
		expect(biasMitigationActive).toBe(false);
		expect(description).toContain("bias mitigation OFF");
	});

	it("throws when QUIRE_JUDGE_LLM_PROVIDER=anthropic is set but no anthropic key is available anywhere", () => {
		const shared = new StubLlmProvider();
		expect(() => resolveJudgeProvider({ QUIRE_JUDGE_LLM_PROVIDER: "anthropic" }, shared)).toThrow(/ANTHROPIC_API_KEY/);
	});
});
