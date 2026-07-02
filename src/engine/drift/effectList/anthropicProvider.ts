import type { LlmCall, LlmCallOptions, LlmMessage, LlmProvider } from "./provider.js";
import { fetchWithRetry } from "./httpRetry.js";

export const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_MAX_TOKENS = 1024;
const ANTHROPIC_VERSION = "2023-06-01";

export interface AnthropicProviderConfig {
	apiKey: string;
	baseUrl?: string;
	model?: string;
}

interface AnthropicMessagesResponse {
	content?: ReadonlyArray<{ type: string; text?: string }>;
}

export class AnthropicLlmProvider implements LlmProvider {
	private readonly _calls: LlmCall[] = [];
	private readonly baseUrl: string;
	private readonly model: string;

	constructor(private readonly config: AnthropicProviderConfig) {
		this.baseUrl = config.baseUrl ?? "https://api.anthropic.com";
		this.model = config.model ?? DEFAULT_MODEL;
	}

	get calls(): ReadonlyArray<LlmCall> {
		return this._calls;
	}

	get modelKey(): string {
		return `anthropic:${this.model}`;
	}

	async complete(messages: ReadonlyArray<LlmMessage>, opts?: LlmCallOptions): Promise<string> {
		const system = messages.find((m) => m.role === "system")?.content;
		const turns = messages
			.filter((m) => m.role !== "system")
			.map((m) => ({ role: m.role, content: m.content }));

		const res = await fetchWithRetry("Anthropic", `${this.baseUrl}/v1/messages`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-api-key": this.config.apiKey,
				"anthropic-version": ANTHROPIC_VERSION,
			},
			body: JSON.stringify({
				model: this.model,
				max_tokens: opts?.maxTokens ?? DEFAULT_MAX_TOKENS,
				temperature: opts?.temperature ?? 0,
				...(system !== undefined ? { system } : {}),
				messages: turns,
			}),
		});

		const data = (await res.json()) as AnthropicMessagesResponse;
		const text = data.content?.find((block) => block.type === "text")?.text ?? "";
		this._calls.push({ messages, response: text });
		return text;
	}

	// Anthropic has no embeddings endpoint. textSimilarity() (similarity.ts) already
	// falls back to Jaccard similarity over the real extracted-effect text whenever
	// embed() reports all-zero vectors, so returning [] here routes straight to that
	// existing, tested path instead of faking a vector.
	async embed(_text: string): Promise<ReadonlyArray<number>> {
		return [];
	}
}
