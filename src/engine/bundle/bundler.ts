import type { Bundle, PullRequest } from "../types/core.js";
import type { LlmProvider } from "../drift/effectList/provider.js";
import { extractEffects } from "../drift/effectList/extractor.js";
import { clusterPRs, type ClusteringFailure } from "./similarity.js";
import { settleWithConcurrency } from "../util/concurrency.js";

const EXTRACTION_CONCURRENCY = 4;

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
	// PRs excluded from this round because comparing them against every existing
	// cluster failed. Same partial-failure contract as extractionFailures, one
	// phase later.
	clusteringFailures: ReadonlyArray<ClusteringFailure>;
}

export async function buildBundles(
	prs: ReadonlyArray<PullRequest>,
	provider: LlmProvider,
	config: BundleConfig,
): Promise<BundleResult> {
	if (prs.length === 0) {
		return { bundles: [], effectsByPr: new Map(), extractionFailures: [], clusteringFailures: [] };
	}

	// Extraction is independent per PR, so it runs concurrently (capped) rather than
	// one network round-trip at a time — settleWithConcurrency keeps one PR's failure
	// from blocking the rest, matching the per-PR partial-failure contract below, and
	// bounds how many requests fire at once against a rate-limited provider.
	const results = await settleWithConcurrency(prs, EXTRACTION_CONCURRENCY, (pr) =>
		extractEffects(pr.diff, pr.testNamesChanged, provider).then((effects) => ({ pr, effects })),
	);

	const effectsByPr = new Map<string, ReadonlyArray<string>>();
	const extractionFailures: ExtractionFailure[] = [];
	const extracted: PullRequest[] = [];
	for (let i = 0; i < results.length; i++) {
		const result = results[i]!;
		const pr = prs[i]!;
		if (result.status === "fulfilled") {
			effectsByPr.set(pr.id, result.value.effects);
			extracted.push(pr);
		} else {
			extractionFailures.push({
				pr,
				error: result.reason instanceof Error ? result.reason.message : String(result.reason),
			});
		}
	}

	const { clusters, failures: clusteringFailures } = await clusterPRs(
		extracted, effectsByPr, provider, { threshold: config.similarityThreshold },
	);

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

	return { bundles, effectsByPr, extractionFailures, clusteringFailures };
}
