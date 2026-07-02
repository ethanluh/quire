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
	// Only meaningful when supportsEmbeddings is true. Implementations backed by a
	// vendor with no embeddings endpoint should return [] rather than a fabricated
	// vector — clusterPRs() (similarity.ts) never calls embed() on such a provider
	// in the first place, since it branches on supportsEmbeddings up front.
	embed(text: string): Promise<ReadonlyArray<number>>;
	// Declared, not inferred: clusterPRs() (similarity.ts) uses this to pick its
	// clustering strategy up front — cosine similarity over real embed() vectors when
	// true, a single LLM classification call per PR (clusterClassifier.ts) when false.
	// A provider must not signal "no embeddings" by returning an all-zero vector at
	// call time; it declares the capability statically instead. Swapping which of
	// the two is true for a given provider changes which clustering algorithm
	// bundles PRs, not just which vendor serves the request.
	readonly supportsEmbeddings: boolean;
	readonly calls: ReadonlyArray<LlmCall>;
	// Identifies this provider+model configuration for cache-keying (see
	// src/engine/cache/prCache.ts): two providers/models must never share a modelKey, so
	// switching which one is active invalidates cached extraction/embedding results
	// instead of silently serving output produced by a different model.
	readonly modelKey: string;
}

export type EmbeddingProvider = Pick<LlmProvider, "embed">;
