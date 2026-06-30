import type { Bundle, PullRequest } from "../types/core.js";
import type { EmbeddingProvider } from "../drift/effectList/provider.js";
import { clusterPRs } from "./similarity.js";

function stableId(prIds: ReadonlyArray<string>): string {
	const sorted = [...prIds].sort();
	let hash = 0;
	for (const id of sorted) {
		for (let i = 0; i < id.length; i++) {
			hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
		}
	}
	return `bundle-${(hash >>> 0).toString(16)}`;
}

export interface BundleConfig {
	similarityThreshold: number;
}

export async function buildBundles(
	prs: ReadonlyArray<PullRequest>,
	provider: EmbeddingProvider,
	config: BundleConfig,
): Promise<ReadonlyArray<Bundle>> {
	if (prs.length === 0) return [];

	const clusters = await clusterPRs(prs, provider, { threshold: config.similarityThreshold });

	return clusters.map((members): Bundle => {
		const anchor = members[0];
		if (anchor === undefined) throw new Error("Cluster must have at least one member");
		return {
			id: stableId(members.map((m) => m.id)),
			direction: anchor.declaredDirection,
			members,
		};
	});
}
