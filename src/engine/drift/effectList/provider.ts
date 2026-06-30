export interface LlmMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

export interface LlmCallOptions {
	maxTokens?: number;
	temperature?: number;
}

export interface LlmCall {
	messages: ReadonlyArray<LlmMessage>;
	response: string;
}

export interface LlmProvider {
	complete(messages: ReadonlyArray<LlmMessage>, opts?: LlmCallOptions): Promise<string>;
	embed(text: string): Promise<ReadonlyArray<number>>;
	readonly calls: ReadonlyArray<LlmCall>;
}

export type EmbeddingProvider = Pick<LlmProvider, "embed">;
