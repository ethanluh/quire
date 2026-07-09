import type { Bundle } from "../types/core.js";
import type { DecidedPrEntry } from "../types/decided.js";
import type { QueueState } from "../types/queue.js";
import type { ShelfState } from "../types/shelf.js";
import type { PrecedentExample } from "../types/judge.js";

const DEFAULT_LIMIT = 5;

// Excluded so two unrelated effect summaries don't register as "similar" purely because
// they both happen to contain "the"/"to"/"a" — with effect-summary-length token sets (a
// handful of words), even one common stopword is enough to produce a false nonzero overlap.
const STOPWORDS: ReadonlySet<string> = new Set([
	"a", "an", "the", "to", "of", "and", "or", "in", "on", "for", "with", "this", "that", "is", "are", "it", "its",
]);

function tokenize(text: string): ReadonlySet<string> {
	return new Set(
		text
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter((t) => t.length > 0 && !STOPWORDS.has(t)),
	);
}

// Deliberately not the LLM-classification/embedding machinery similarity.ts uses to cluster
// PRs into bundles — that's a hard membership decision earning its cost; this is few-shot
// grounding context, where a cheap, deterministic, zero-cost-and-zero-latency ranking is the
// right tool. Symmetric Jaccard overlap over lowercased word sets.
function jaccardSimilarity(a: string, b: string): number {
	const setA = tokenize(a);
	const setB = tokenize(b);
	if (setA.size === 0 || setB.size === 0) return 0;
	let intersection = 0;
	for (const token of setA) {
		if (setB.has(token)) intersection++;
	}
	const union = setA.size + setB.size - intersection;
	return union === 0 ? 0 : intersection / union;
}

interface PastBundle {
	bundleId: string;
	direction: string;
	effectSummary: string;
	// The queue/shelf-derived status this bundle ended up in — used only to cross-check
	// against decidedPrEntries below, never trusted on its own (see the comment at the
	// call site: a "closed" queue entry can mean a human reject OR a member PR closed
	// externally without merging, and only the decided-PR record distinguishes them).
	inferredGesture: "accept" | "reject" | "defer";
}

function collectPastBundles(queueState: QueueState, shelfState: ShelfState): ReadonlyArray<PastBundle> {
	const fromQueue: PastBundle[] = queueState.entries
		.filter((e) => e.status === "landed" || e.status === "closed" || e.status === "reverted")
		.map((e) => ({
			bundleId: e.bundleId,
			direction: e.bundle.direction,
			effectSummary: e.bundle.effectSummary,
			inferredGesture: e.status === "closed" ? "reject" : "accept",
		}));
	const fromShelf: PastBundle[] = shelfState.entries
		.filter((e) => e.bundle !== undefined)
		.map((e) => ({
			bundleId: e.bundleId,
			direction: e.bundle!.direction,
			effectSummary: e.bundle!.effectSummary,
			inferredGesture: "defer",
		}));
	return [...fromQueue, ...fromShelf];
}

// Precedent must be a human's own directional call (see PrecedentExample's own doc comment)
// — a queue/shelf entry's status alone isn't proof of that (a "closed" queue entry can be a
// human reject, or a member PR closed externally without merging; see recordExternalClose in
// mergeQueue.ts). DecidedPrStore's entries exist ONLY as a side effect of gestures.ts's three
// human-gesture branches, so cross-checking against them is the actual confirmation — same
// "don't infer a human decision from a side effect, confirm it from the authoritative record"
// discipline INV-1 already applies to declaredDirection.
function confirmedHumanGesture(
	bundleId: string,
	inferredGesture: "accept" | "reject" | "defer",
	decidedEntries: ReadonlyArray<DecidedPrEntry>,
): boolean {
	return decidedEntries.some((entry) => entry.bundleId === bundleId && entry.action === inferredGesture);
}

// Retrieves the nearest past human-decided bundles to `candidate`, for use as few-shot
// grounding in the judge prompt (bundleJudge.ts) and as the judge's own eval set (mission
// §C). Reads existing per-team state directly — queue.json (landed/closed/reverted entries
// carry their full Bundle) and shelf.json (deferred entries) — no new persisted store.
export function retrievePrecedent(
	candidate: Bundle,
	queueState: QueueState,
	shelfState: ShelfState,
	decidedEntries: ReadonlyArray<DecidedPrEntry>,
	limit: number = DEFAULT_LIMIT,
): ReadonlyArray<PrecedentExample> {
	const past = collectPastBundles(queueState, shelfState).filter(
		(b) => b.bundleId !== candidate.id && confirmedHumanGesture(b.bundleId, b.inferredGesture, decidedEntries),
	);

	const scored: PrecedentExample[] = past
		.map((b) => ({
			bundleId: b.bundleId,
			direction: b.direction,
			effectSummary: b.effectSummary,
			gesture: b.inferredGesture,
			similarity: jaccardSimilarity(candidate.effectSummary, b.effectSummary),
		}))
		.filter((example) => example.similarity > 0);

	scored.sort((a, b) => b.similarity - a.similarity);
	return scored.slice(0, limit);
}
