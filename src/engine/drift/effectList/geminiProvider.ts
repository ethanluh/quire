import type { LlmCall, LlmCallOptions, LlmMessage, LlmProvider } from "./provider.js";
import { fetchWithRetry } from "./httpRetry.js";

export const DEFAULT_MODEL = "gemini-2.0-flash";
const DEFAULT_EMBEDDING_MODEL = "text-embedding-004";
const DEFAULT_MAX_TOKENS = 1024;

export interface GeminiProviderConfig {
	apiKey: string;
	baseUrl?: string;
	model?: string;
	embeddingModel?: string;
}

interface GeminiGenerateContentResponse {
	candidates?: ReadonlyArray<{ content?: { parts?: ReadonlyArray<{ text?: string }> } }>;
}

interface GeminiEmbedContentResponse {
	embedding?: { values?: ReadonlyArray<number> };
}

export class GeminiLlmProvider implements LlmProvider {
	private readonly _calls: LlmCall[] = [];
	private readonly baseUrl: string;
	private readonly model: string;
	private readonly embeddingModel: string;

	constructor(private readonly config: GeminiProviderConfig) {
		this.baseUrl = config.baseUrl ?? "https://generativelanguage.googleapis.com";
		this.model = config.model ?? DEFAULT_MODEL;
		this.embeddingModel = config.embeddingModel ?? DEFAULT_EMBEDDING_MODEL;
	}

	get calls(): ReadonlyArray<LlmCall> {
		return this._calls;
	}

	async complete(messages: ReadonlyArray<LlmMessage>, opts?: LlmCallOptions): Promise<string> {
		const system = messages.find((m) => m.role === "system")?.content;
		// Gemini has no "system" role in contents and calls the assistant turn "model".
		const contents = messages
			.filter((m) => m.role !== "system")
			.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));

		const res = await fetchWithRetry(
			"Gemini",
			`${this.baseUrl}/v1beta/models/${this.model}:generateContent?key=${this.config.apiKey}`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					...(system !== undefined ? { systemInstruction: { parts: [{ text: system }] } } : {}),
					contents,
					generationConfig: {
						maxOutputTokens: opts?.maxTokens ?? DEFAULT_MAX_TOKENS,
						temperature: opts?.temperature ?? 0,
					},
				}),
			},
		);

		const data = (await res.json()) as GeminiGenerateContentResponse;
		const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
		this._calls.push({ messages, response: text });
		return text;
	}

	async embed(text: string): Promise<ReadonlyArray<number>> {
		const res = await fetchWithRetry(
			"Gemini",
			`${this.baseUrl}/v1beta/models/${this.embeddingModel}:embedContent?key=${this.config.apiKey}`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ content: { parts: [{ text }] } }),
			},
		);

		const data = (await res.json()) as GeminiEmbedContentResponse;
		return data.embedding?.values ?? [];
	}
}
