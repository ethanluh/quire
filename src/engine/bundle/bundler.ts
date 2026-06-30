import type { Bundle, PullRequest } from "../types/core.js";
import type { LlmProvider } from "../drift/effectList/provider.js";
import { extractEffects } from "../drift/effectList/extractor.js";
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

export interface BundleResult {
	bundles: ReadonlyArray<Bundle>;
	// Effects extracted blind to declaredDirection (INV-2) while clustering — handed
	// back so the drift check can reuse them instead of re-extracting per member.
	effectsByPr: ReadonlyMap<string, ReadonlyArray<string>>;
}

export async function buildBundles(
	prs: ReadonlyArray<PullRequest>,
	provider: LlmProvider,
	config: BundleConfig,
): Promise<BundleResult> {
	if (prs.length === 0) return { bundles: [], effectsByPr: new Map() };

	const effectsByPr = new Map<string, ReadonlyArray<string>>();
	for (const pr of prs) {
		effectsByPr.set(pr.id, await extractEffects(pr.diff, pr.testNamesChanged, provider));
	}

	const clusters = await clusterPRs(prs, effectsByPr, provider, { threshold: config.similarityThreshold });

	const bundles = clusters.map((members): Bundle => {
		const anchor = members[0];
		if (anchor === undefined) throw new Error("Cluster must have at least one member");
		return {
			id: stableId(members.map((m) => m.id)),
			direction: anchor.declaredDirection,
			members,
		};
	});

	return { bundles, effectsByPr };
}
