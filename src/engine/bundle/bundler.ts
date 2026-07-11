import type { Bundle, PullRequest } from "../types/core.js";
import type { LlmProvider } from "../drift/effectList/provider.js";
import { extractEffects } from "../drift/effectList/extractor.js";
import { clusterPRs, type ClusteringFailure, type ClusterSeed } from "./similarity.js";
import { settleWithConcurrency } from "../util/concurrency.js";
import { errorMessage } from "../util/error.js";
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

	const currentById = new Map(prs.map((pr) => [pr.id, pr]));
	const modelKey = provider.modelKey;

	const cacheHits = new Map<string, ReadonlyArray<string>>();
	const toExtract: PullRequest[] = [];
	for (const pr of prs) {
		const cached = prCache.getEffects(pr.id, pr.headSha, modelKey);
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
			prCache.putEffects(pr.id, pr.headSha, pr.repoOwner, pr.repoName, result.value.effects, modelKey);
		} else {
			extractionFailures.push({
				pr,
				error: errorMessage(result.reason),
			});
		}
	}

	// A prior bundle can only be seeded (its members skipped in clustering entirely)
	// when every one of its members is both still present in this run's PR set and
	// unchanged (not re-extracted, and — since a PR body edit with no new commit is a
	// cache hit for effects, not a re-extraction — with the same declaredDirection/
	// directionInferred as when this bundle was last computed). A single changed or
	// missing (closed/merged) member invalidates the whole seed — its still-present
	// members fall back to the normal comparison loop below rather than risk carrying a
	// stale centroid (the anchor may be the one that changed) or duplicating a member
	// across two clusters. Without the direction-fields check, an edited PR whose marker
	// was added/removed would stay stuck in its old bundle (an undeclared singleton
	// missing a chance to join a matching bundle, or worse, a now-undeclared PR left
	// grouped inside a multi-PR bundle in violation of INV-1/INV-3) until its next commit.
	const currentIds = new Set(currentById.keys());
	const seeds: ClusterSeed[] = [];
	const seededIds = new Set<string>();
	for (const bundle of priorBundles) {
		const allUnchanged = bundle.members.every((m) => {
			const current = currentById.get(m.id);
			return (
				current !== undefined &&
				!reextractedPrIds.has(m.id) &&
				current.declaredDirection === m.declaredDirection &&
				current.directionInferred === m.directionInferred
			);
		});
		if (!allUnchanged) continue;
		// Refresh every seed member to this run's freshly-fetched PullRequest object
		// instead of carrying the prior run's object forward — declaredDirection/ciStatus/
		// title are metadata re-fetched on every refresh independent of headSha, so a
		// PR body edit or CI status change with no new commit must still surface here even
		// though the seed itself (its effects/clustering) is otherwise untouched. `?? m`
		// is unreachable given the `currentIds.has(m.id)` check above, kept only as a
		// type-safety fallback. No centroidText here — clusterPRs derives each member's own
		// effect text from `effectsByPr`, which already covers every current PR.
		seeds.push({
			members: bundle.members.map((m) => currentById.get(m.id) ?? m),
		});
		for (const m of bundle.members) seededIds.add(m.id);
	}
	const toCluster = extracted.filter((pr) => !seededIds.has(pr.id));

	// PRs with no real declared direction must never be grouped with another PR — not with
	// a declared PR (that would attribute a fabricated direction to them, INV-1) and not
	// with each other on the strength of sharing similar title/body text (that would
	// manufacture agreement out of mutual absence of a declaration, INV-1/INV-3). This
	// covers both "no fallback possible" (the sentinel) and "fallback inferred from
	// title/description" — directionInferred is true either way. Pull them out before
	// similarity clustering runs and give each its own singleton bundle.
	const undeclared = toCluster.filter((pr) => pr.directionInferred);
	const toClusterDeclared = toCluster.filter((pr) => !pr.directionInferred);

	const { clusters, failures: clusteringFailures } = await clusterPRs(
		toClusterDeclared, effectsByPr, provider, { threshold: config.similarityThreshold }, seeds, prCache, modelKey,
	);

	const allClusters = [...clusters, ...undeclared.map((pr) => [pr])];

	const bundles = allClusters.map((members): Bundle => {
		const anchor = members[0];
		if (anchor === undefined) throw new Error("Cluster must have at least one member");
		return {
			id: stableId(members.map((m) => m.id)),
			direction: anchor.declaredDirection,
			directionInferred: anchor.directionInferred,
			effectSummary: (effectsByPr.get(anchor.id) ?? []).join(". "),
			members,
		};
	});

	// One write for the whole batch instead of one per extracted/embedded item — every
	// mutation above (putEffects, and putEmbedding inside clusterPRs) only touched
	// in-memory state; this is the single point that actually persists it to disk.
	await prCache.save();

	return { bundles, effectsByPr, extractionFailures, clusteringFailures, reextractedPrIds };
}
