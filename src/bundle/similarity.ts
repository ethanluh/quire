import type { PullRequest } from "../types/core.js";
import type { EmbeddingProvider } from "../drift/effectList/provider.js";

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
	const tokensA = new Set(a.toLowerCase().split(/\s+/));
	const tokensB = new Set(b.toLowerCase().split(/\s+/));
	let intersection = 0;
	for (const t of tokensA) {
		if (tokensB.has(t)) intersection++;
	}
	const union = tokensA.size + tokensB.size - intersection;
	return union === 0 ? 0 : intersection / union;
}

export async function directionalSimilarity(
	a: string,
	b: string,
	provider: EmbeddingProvider,
): Promise<number> {
	try {
		const [vecA, vecB] = await Promise.all([provider.embed(a), provider.embed(b)]);
		const allZeroA = vecA.every((v) => v === 0);
		const allZeroB = vecB.every((v) => v === 0);
		if (allZeroA || allZeroB) return jaccardSimilarity(a, b);
		return cosineSimilarity(vecA, vecB);
	} catch {
		return jaccardSimilarity(a, b);
	}
}

export interface ClusterConfig {
	threshold: number;
}

export async function clusterPRs(
	prs: ReadonlyArray<PullRequest>,
	provider: EmbeddingProvider,
	config: ClusterConfig,
): Promise<ReadonlyArray<ReadonlyArray<PullRequest>>> {
	const clusters: PullRequest[][] = [];
	const centroids: string[] = [];

	for (const pr of prs) {
		let bestIdx = -1;
		let bestScore = -1;
		for (let i = 0; i < centroids.length; i++) {
			const centroid = centroids[i];
			if (centroid === undefined) continue;
			const score = await directionalSimilarity(pr.declaredDirection, centroid, provider);
			if (score > bestScore) {
				bestScore = score;
				bestIdx = i;
			}
		}
		if (bestScore >= config.threshold && bestIdx >= 0) {
			clusters[bestIdx]!.push(pr);
		} else {
			clusters.push([pr]);
			centroids.push(pr.declaredDirection);
		}
	}

	return clusters;
}
