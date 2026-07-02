import type { PullRequest } from "../types/core.js";
import type { EmbeddingProvider } from "../drift/effectList/provider.js";
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

function jaccardSimilarity(a: string, b: string): number {
	const tokensA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
	const tokensB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
	let intersection = 0;
	for (const t of tokensA) {
		if (tokensB.has(t)) intersection++;
	}
	const union = tokensA.size + tokensB.size - intersection;
	return union === 0 ? 0 : intersection / union;
}

// An embed() failure (real API error/outage) is let through rather than caught here,
// so it propagates to the caller instead of being silently indistinguishable from a
// provider's intentional all-zero-vector opt-out (see provider.ts's embed() contract).
export async function textSimilarity(
	a: string,
	b: string,
	provider: EmbeddingProvider,
): Promise<number> {
	const [vecA, vecB] = await Promise.all([provider.embed(a), provider.embed(b)]);
	const allZeroA = vecA.every((v) => v === 0);
	const allZeroB = vecB.every((v) => v === 0);
	if (allZeroA || allZeroB) return jaccardSimilarity(a, b);
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

// Clusters on extracted-effect text, never on declaredDirection (INV-1): membership
// must rest on the independent evidence the drift check produces, not the untrusted
// declared-direction prior. effectsByPr is expected to come from extraction that ran
// blind to declaredDirection (INV-2).
export async function clusterPRs(
	prs: ReadonlyArray<PullRequest>,
	effectsByPr: ReadonlyMap<string, ReadonlyArray<string>>,
	provider: EmbeddingProvider,
	config: ClusterConfig,
): Promise<ClusterResult> {
	const clusters: PullRequest[][] = [];
	const centroids: string[] = [];
	const failures: ClusteringFailure[] = [];

	// Caches in-flight/resolved embeddings by text for the life of this call, since a
	// real network-backed provider.embed() would otherwise re-embed the same unchanged
	// centroid on every subsequent PR comparison. Caching the promise (not just the
	// resolved value) also dedupes concurrent requests for the same text. A rejection
	// is evicted rather than cached, so a transient failure doesn't permanently poison
	// every later comparison against that same text for the rest of this call.
	const embedCache = new Map<string, Promise<ReadonlyArray<number>>>();
	function cachedEmbed(text: string): Promise<ReadonlyArray<number>> {
		const cached = embedCache.get(text);
		if (cached !== undefined) return cached;
		const promise = provider.embed(text);
		embedCache.set(text, promise);
		promise.catch(() => embedCache.delete(text));
		return promise;
	}
	const cachingProvider: EmbeddingProvider = { embed: cachedEmbed };

	for (const pr of prs) {
		const prEffectText = (effectsByPr.get(pr.id) ?? []).join(". ");
		// Comparisons against every existing centroid are independent of each other for
		// this PR, so they run concurrently (capped) instead of one round-trip at a time.
		// A failure here must not discard clustering progress made for every other PR —
		// skip this PR for this round instead, the same way extraction failures are
		// isolated per-PR in buildBundles().
		const settled = await settleWithConcurrency(
			centroids,
			CENTROID_COMPARISON_CONCURRENCY,
			(centroid) => textSimilarity(prEffectText, centroid, cachingProvider),
		);
		const firstFailure = settled.find((r) => r.status === "rejected");
		if (firstFailure !== undefined && firstFailure.status === "rejected") {
			failures.push({
				pr,
				error: firstFailure.reason instanceof Error ? firstFailure.reason.message : String(firstFailure.reason),
			});
			continue;
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
		if (bestScore >= config.threshold && bestIdx >= 0) {
			clusters[bestIdx]!.push(pr);
		} else {
			clusters.push([pr]);
			centroids.push(prEffectText);
		}
	}

	return { clusters, failures };
}
