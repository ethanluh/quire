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

export interface ExtractionFailure {
	pr: PullRequest;
	error: string;
}

export interface BundleResult {
	bundles: ReadonlyArray<Bundle>;
	// Effects extracted blind to declaredDirection (INV-2) while clustering — handed
	// back so the drift check can reuse them instead of re-extracting per member.
	effectsByPr: ReadonlyMap<string, ReadonlyArray<string>>;
	// PRs excluded from this round because their effect extraction failed. Kept
	// separate from a thrown error so one bad extraction doesn't discard bundling
	// progress already made for every other PR (mirrors orchestratePipeline's
	// partial-failure contract).
	extractionFailures: ReadonlyArray<ExtractionFailure>;
}

export async function buildBundles(
	prs: ReadonlyArray<PullRequest>,
	provider: LlmProvider,
	config: BundleConfig,
): Promise<BundleResult> {
	if (prs.length === 0) return { bundles: [], effectsByPr: new Map(), extractionFailures: [] };

	const effectsByPr = new Map<string, ReadonlyArray<string>>();
	const extractionFailures: ExtractionFailure[] = [];
	const extracted: PullRequest[] = [];
	for (const pr of prs) {
		try {
			effectsByPr.set(pr.id, await extractEffects(pr.diff, pr.testNamesChanged, provider));
			extracted.push(pr);
		} catch (err) {
			extractionFailures.push({ pr, error: err instanceof Error ? err.message : String(err) });
		}
	}

	const clusters = await clusterPRs(extracted, effectsByPr, provider, { threshold: config.similarityThreshold });

	const bundles = clusters.map((members): Bundle => {
		const anchor = members[0];
		if (anchor === undefined) throw new Error("Cluster must have at least one member");
		return {
			id: stableId(members.map((m) => m.id)),
			direction: anchor.declaredDirection,
			effectSummary: (effectsByPr.get(anchor.id) ?? []).join(". "),
			members,
		};
	});

	return { bundles, effectsByPr, extractionFailures };
}
