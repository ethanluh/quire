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
	// An all-zero or empty vector is the documented "no real embedding" sentinel:
	// clusterPRs()/textSimilarity() (similarity.ts) treats it as an opt-out and falls
	// back to Jaccard text similarity instead of cosine similarity. Implementations
	// backed by a vendor with no embeddings endpoint should return [] rather than a
	// fabricated vector. Note that swapping between an implementation with real
	// embeddings and one that always opts out changes which clustering algorithm
	// bundles PRs, not just which vendor serves the request.
	embed(text: string): Promise<ReadonlyArray<number>>;
	readonly calls: ReadonlyArray<LlmCall>;
	// Identifies this provider+model configuration for cache-keying (see
	// src/engine/cache/prCache.ts): two providers/models must never share a modelKey, so
	// switching which one is active invalidates cached extraction/embedding results
	// instead of silently serving output produced by a different model.
	readonly modelKey: string;
}

export type EmbeddingProvider = Pick<LlmProvider, "embed">;
