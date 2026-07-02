import type { Bundle, PullRequest } from "../types/core.js";
import type { LlmProvider } from "../drift/effectList/provider.js";
import { extractEffects } from "../drift/effectList/extractor.js";
import { clusterPRs, type ClusteringFailure, type ClusterSeed } from "./similarity.js";
import { settleWithConcurrency } from "../util/concurrency.js";
import { PrEffectCache } from "../cache/prCache.js";

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
	// PR ids whose effects were freshly (re-)extracted this run — i.e. a cache miss,
	// meaning their content changed since the last run (or they're new). Bundles with no
	// re-extracted member and no membership change can safely skip drift re-screening
	// (see orchestratePipeline).
	reextractedPrIds: ReadonlySet<string>;
}

export async function buildBundles(
	prs: ReadonlyArray<PullRequest>,
	provider: LlmProvider,
	config: BundleConfig,
	// Ephemeral by default: with no cache passed in, every PR is always a cache miss,
	// which reproduces today's "always extract, always cluster fresh" behavior exactly.
	prCache: PrEffectCache = new PrEffectCache(),
	// Bundles from the previous run, used to seed clustering so unchanged bundles skip
	// re-comparison entirely (see the seed-validity check below). Empty by default,
	// which reproduces today's full-batch clustering exactly.
	priorBundles: ReadonlyArray<Bundle> = [],
): Promise<BundleResult> {
	if (prs.length === 0) {
		return { bundles: [], effectsByPr: new Map(), extractionFailures: [], clusteringFailures: [], reextractedPrIds: new Set() };
	}

	const cacheHits = new Map<string, ReadonlyArray<string>>();
	const toExtract: PullRequest[] = [];
	for (const pr of prs) {
		const cached = prCache.getEffects(pr.id, pr.headSha);
		if (cached !== undefined) {
			cacheHits.set(pr.id, cached);
		} else {
			toExtract.push(pr);
		}
	}

	// Extraction is independent per PR, so it runs concurrently (capped) rather than
	// one network round-trip at a time — settleWithConcurrency keeps one PR's failure
	// from blocking the rest, matching the per-PR partial-failure contract below, and
	// bounds how many requests fire at once against a rate-limited provider. Only PRs
	// that missed the cache (new, or headSha changed since last run) go through this.
	const results = await settleWithConcurrency(toExtract, EXTRACTION_CONCURRENCY, (pr) =>
		extractEffects(pr.diff, pr.testNamesChanged, provider).then((effects) => ({ pr, effects })),
	);

	const effectsByPr = new Map<string, ReadonlyArray<string>>(cacheHits);
	const extractionFailures: ExtractionFailure[] = [];
	const reextractedPrIds = new Set<string>();
	const extracted: PullRequest[] = prs.filter((pr) => cacheHits.has(pr.id));
	for (let i = 0; i < results.length; i++) {
		const result = results[i]!;
		const pr = toExtract[i]!;
		if (result.status === "fulfilled") {
			effectsByPr.set(pr.id, result.value.effects);
			extracted.push(pr);
			reextractedPrIds.add(pr.id);
			await prCache.putEffects(pr.id, pr.headSha, pr.repoOwner, pr.repoName, result.value.effects);
		} else {
			extractionFailures.push({
				pr,
				error: result.reason instanceof Error ? result.reason.message : String(result.reason),
			});
		}
	}

	// A prior bundle can only be seeded (its members skipped in clustering entirely)
	// when every one of its members is both still present in this run's PR set and
	// unchanged (not re-extracted). A single changed or missing (closed/merged) member
	// invalidates the whole seed — its still-present members fall back to the normal
	// comparison loop below rather than risk carrying a stale centroid (the anchor may
	// be the one that changed) or duplicating a member across two clusters.
	const currentIds = new Set(prs.map((pr) => pr.id));
	const seeds: ClusterSeed[] = [];
	const seededIds = new Set<string>();
	for (const bundle of priorBundles) {
		const allUnchanged = bundle.members.every(
			(m) => currentIds.has(m.id) && !reextractedPrIds.has(m.id),
		);
		if (!allUnchanged) continue;
		seeds.push({ centroidText: bundle.effectSummary, members: bundle.members });
		for (const m of bundle.members) seededIds.add(m.id);
	}
	const toCluster = extracted.filter((pr) => !seededIds.has(pr.id));

	const { clusters, failures: clusteringFailures } = await clusterPRs(
		toCluster, effectsByPr, provider, { threshold: config.similarityThreshold }, seeds, prCache,
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

	return { bundles, effectsByPr, extractionFailures, clusteringFailures, reextractedPrIds };
}
