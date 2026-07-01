import { describe, it, expect } from "@jest/globals";
import { resolveLlmProvider } from "../../src/interface/server/resolveLlmProvider.js";
import { StubLlmProvider } from "../../src/engine/drift/effectList/stubProvider.js";
import { AnthropicLlmProvider } from "../../src/engine/drift/effectList/anthropicProvider.js";
import { GeminiLlmProvider } from "../../src/engine/drift/effectList/geminiProvider.js";

describe("resolveLlmProvider", () => {
	it("falls back to the stub when no key and no LLM_PROVIDER are set", () => {
		const { provider, description } = resolveLlmProvider({});
		expect(provider).toBeInstanceOf(StubLlmProvider);
		expect(description).toContain("stub");
	});

	it("auto-selects anthropic when only ANTHROPIC_API_KEY is set", () => {
		const { provider } = resolveLlmProvider({ ANTHROPIC_API_KEY: "sk-test" });
		expect(provider).toBeInstanceOf(AnthropicLlmProvider);
	});

	it("auto-selects gemini when only GEMINI_API_KEY is set", () => {
		const { provider } = resolveLlmProvider({ GEMINI_API_KEY: "gk-test" });
		expect(provider).toBeInstanceOf(GeminiLlmProvider);
	});

	it("prefers anthropic over gemini when both keys are set and LLM_PROVIDER is unset", () => {
		const { provider, description } = resolveLlmProvider({
			ANTHROPIC_API_KEY: "sk-test",
			GEMINI_API_KEY: "gk-test",
		});
		expect(provider).toBeInstanceOf(AnthropicLlmProvider);
		expect(description).toContain("anthropic");
	});

	it("LLM_PROVIDER=gemini selects gemini even when an anthropic key is also set", () => {
		const { provider } = resolveLlmProvider({
			ANTHROPIC_API_KEY: "sk-test",
			GEMINI_API_KEY: "gk-test",
			LLM_PROVIDER: "gemini",
		});
		expect(provider).toBeInstanceOf(GeminiLlmProvider);
	});

	it("throws when LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is unset", () => {
		expect(() => resolveLlmProvider({ LLM_PROVIDER: "anthropic" })).toThrow(/ANTHROPIC_API_KEY/);
	});

	it("throws when LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is an empty string", () => {
		expect(() => resolveLlmProvider({ LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "" })).toThrow(
			/ANTHROPIC_API_KEY/,
		);
	});

	it("throws when LLM_PROVIDER=gemini but GEMINI_API_KEY is unset", () => {
		expect(() => resolveLlmProvider({ LLM_PROVIDER: "gemini" })).toThrow(/GEMINI_API_KEY/);
	});

	it("throws on an unrecognized LLM_PROVIDER value instead of silently falling back to the stub", () => {
		expect(() => resolveLlmProvider({ LLM_PROVIDER: "antrhopic", ANTHROPIC_API_KEY: "sk-test" })).toThrow(
			/Unknown LLM_PROVIDER/,
		);
	});

	it("treats an empty-string key the same in auto-detect as in the explicit path (no silent stub fallback with a real key set)", () => {
		// ANTHROPIC_API_KEY="" is treated as absent, so auto-detect falls through to gemini.
		const { provider } = resolveLlmProvider({ ANTHROPIC_API_KEY: "", GEMINI_API_KEY: "gk-test" });
		expect(provider).toBeInstanceOf(GeminiLlmProvider);
	});

	it("respects ANTHROPIC_MODEL/ANTHROPIC_BASE_URL and GEMINI_MODEL overrides in the description", () => {
		const anthropic = resolveLlmProvider({ ANTHROPIC_API_KEY: "sk-test", ANTHROPIC_MODEL: "claude-opus-4-8" });
		expect(anthropic.description).toBe("anthropic (claude-opus-4-8)");

		const gemini = resolveLlmProvider({ GEMINI_API_KEY: "gk-test", GEMINI_MODEL: "gemini-1.5-flash" });
		expect(gemini.description).toBe("gemini (gemini-1.5-flash)");
	});
});
