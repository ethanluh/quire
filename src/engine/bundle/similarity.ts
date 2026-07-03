import type { PullRequest } from "../types/core.js";
import type { LlmProvider } from "../drift/effectList/provider.js";
import { classifyBestMatch } from "../drift/effectList/clusterClassifier.js";
import { settleWithConcurrency } from "../util/concurrency.js";

const CENTROID_COMPARISON_CONCURRENCY = 4;

function cosineSimilarity(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
	let dot = 0, normA = 0, normB = 0;
	for (let i = 0; i < a.length; i++) {
		const ai = a[i] ?? 0;
		const bi = b[i] ?? 0;
		dot += ai * bi;
		normA += ai * ai;
		normB += bi * bi;
	}
	if (normA === 0 || normB === 0) return 0;
	return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Only ever called for a provider with supportsEmbeddings = true (see clusterPRs below) —
// a provider that opts out of embeddings never reaches this function, so it doesn't need
// to defend against all-zero/empty vectors itself.
//
// An embed() failure (real API error/outage) is let through rather than caught here, so it
// propagates to the caller instead of being silently swallowed.
export async function textSimilarity(
	a: string,
	b: string,
	provider: Pick<LlmProvider, "embed">,
): Promise<number> {
	// No extracted effects means no evidence of shared direction, regardless of what a
	// given provider's embed() happens to return for empty/whitespace-only input — a real
	// embedding-capable provider like Gemini returns a real, deterministic, non-zero vector
	// even for empty input, so two such PRs would otherwise score as identical (cosine
	// similarity 1.0) no matter which provider is active. Checking this before any embed()
	// call fixes the invariant at the right layer instead of relying on a particular
	// provider's behavior for degenerate input (INV-1/INV-3: absence of evidence must never
	// become evidence).
	if (a.trim() === "" || b.trim() === "") return 0;
	const [vecA, vecB] = await Promise.all([provider.embed(a), provider.embed(b)]);
	return cosineSimilarity(vecA, vecB);
}

export interface ClusterConfig {
	threshold: number;
}

export interface ClusteringFailure {
	pr: PullRequest;
	error: string;
}

export interface ClusterResult {
	clusters: ReadonlyArray<ReadonlyArray<PullRequest>>;
	// PRs excluded from this round because comparing them against every existing
	// centroid failed (e.g. a real embed() outage). Kept separate from a thrown
	// error so one flaky comparison doesn't discard clustering progress already
	// made for every other PR (mirrors buildBundles()'s extractionFailures contract).
	failures: ReadonlyArray<ClusteringFailure>;
}

// One pre-existing cluster carried over from a prior clusterPRs() call, so its members
// don't need to be re-compared against every centroid again (see buildBundles()'s caller
// for how this is derived from the prior run's Bundle.effectSummary/members).
export interface ClusterSeed {
	centroidText: string;
	members: ReadonlyArray<PullRequest>;
}

// Cross-run embedding memoization, keyed on the embedded text itself plus a model
// identity (structurally satisfied by PrEffectCache — kept as a narrow interface here so
// this module doesn't depend on the concrete cache implementation).
export interface EmbeddingCache {
	getEmbedding(text: string, modelKey: string): ReadonlyArray<number> | undefined;
	putEmbedding(text: string, vector: ReadonlyArray<number>, modelKey: string): void;
}

// Clusters on extracted-effect text, never on declaredDirection (INV-1): membership
// must rest on the independent evidence the drift check produces, not the untrusted
// declared-direction prior. effectsByPr is expected to come from extraction that ran
// blind to declaredDirection (INV-2).
//
// `prs` should contain only PRs not already carried over via `seeds` — every PR passed
// here is compared against every seed centroid plus any centroid created earlier in this
// same call, exactly as if `seeds` didn't exist, just without re-doing the comparisons
// `seeds`' own members already settled in a prior call.
export async function clusterPRs(
	prs: ReadonlyArray<PullRequest>,
	effectsByPr: ReadonlyMap<string, ReadonlyArray<string>>,
	provider: Pick<LlmProvider, "embed" | "complete" | "supportsEmbeddings">,
	config: ClusterConfig,
	seeds: ReadonlyArray<ClusterSeed> = [],
	embeddingCache?: EmbeddingCache,
	// Identifies the embedding provider+model in use — see LlmProvider.modelKey. Ignored
	// when embeddingCache is omitted. Required (not defaulted) whenever a real cache is
	// passed, since a stale default would defeat the point of the cache-key check.
	modelKey = "",
): Promise<ClusterResult> {
	const clusters: PullRequest[][] = seeds.map((s) => [...s.members]);
	const centroids: string[] = seeds.map((s) => s.centroidText);
	const failures: ClusteringFailure[] = [];

	// Resolves one text's embedding: a persisted cache hit short-circuits the network
	// call entirely; a miss calls the real provider and writes the result back.
	async function resolveEmbedding(text: string): Promise<ReadonlyArray<number>> {
		const persisted = embeddingCache?.getEmbedding(text, modelKey);
		if (persisted !== undefined) return persisted;
		const vector = await provider.embed(text);
		embeddingCache?.putEmbedding(text, vector, modelKey);
		return vector;
	}

	// Memoizes the in-flight/resolved promise by text for the life of this call, since a
	// real network-backed provider.embed() would otherwise re-embed the same unchanged
	// centroid on every subsequent PR comparison. Caching the promise (not just the
	// resolved value) also dedupes concurrent requests for the same text — this is a
	// separate, shorter-lived layer from `embeddingCache` above (which persists resolved
	// values across calls/runs; this one only dedupes concurrent callers within this one
	// clusterPRs() invocation). A rejection is evicted rather than cached, so a transient
	// failure doesn't permanently poison every later comparison against that same text.
	const embedCache = new Map<string, Promise<ReadonlyArray<number>>>();
	function cachedEmbed(text: string): Promise<ReadonlyArray<number>> {
		const cached = embedCache.get(text);
		if (cached !== undefined) return cached;
		const promise = resolveEmbedding(text);
		embedCache.set(text, promise);
		promise.catch(() => embedCache.delete(text));
		return promise;
	}
	const cachingProvider: Pick<LlmProvider, "embed"> = { embed: cachedEmbed };

	// Picks the best-matching existing centroid for one PR, or -1 to start a new cluster.
	// Two strategies, chosen once per provider rather than inferred per call (see
	// LlmProvider.supportsEmbeddings): cosine similarity over real embed() vectors when the
	// provider has them, otherwise a single LLM classification call against every centroid
	// at once (clusterClassifier.ts) — cheaper than one LLM call per centroid, and avoids
	// falling back to a weak word-overlap heuristic for providers with no embeddings
	// endpoint (e.g. Anthropic).
	async function bestMatch(prEffectText: string): Promise<number> {
		if (!provider.supportsEmbeddings) return classifyBestMatch(prEffectText, centroids, provider);

		// Comparisons against every existing centroid are independent of each other for
		// this PR, so they run concurrently (capped) instead of one round-trip at a time.
		const settled = await settleWithConcurrency(
			centroids,
			CENTROID_COMPARISON_CONCURRENCY,
			(centroid) => textSimilarity(prEffectText, centroid, cachingProvider),
		);
		const firstFailure = settled.find((r) => r.status === "rejected");
		if (firstFailure !== undefined && firstFailure.status === "rejected") {
			throw firstFailure.reason;
		}

		let bestIdx = -1;
		let bestScore = -1;
		for (let i = 0; i < settled.length; i++) {
			const result = settled[i];
			const score = result?.status === "fulfilled" ? result.value : -1;
			if (score > bestScore) {
				bestScore = score;
				bestIdx = i;
			}
		}
		return bestScore >= config.threshold ? bestIdx : -1;
	}

	for (const pr of prs) {
		const prEffectText = (effectsByPr.get(pr.id) ?? []).join(". ");
		// A failure here must not discard clustering progress made for every other PR —
		// skip this PR for this round instead, the same way extraction failures are
		// isolated per-PR in buildBundles().
		let bestIdx: number;
		try {
			bestIdx = await bestMatch(prEffectText);
		} catch (err) {
			failures.push({ pr, error: err instanceof Error ? err.message : String(err) });
			continue;
		}

		if (bestIdx >= 0) {
			clusters[bestIdx]!.push(pr);
		} else {
			clusters.push([pr]);
			centroids.push(prEffectText);
		}
	}

	return { clusters, failures };
}
