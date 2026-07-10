// Normalizes GitHub's untyped `mergeable_state` string into a closed union at the client
// boundary, so nothing downstream string-matches a raw value GitHub could silently add to.
// "unrecognized" is the fail-closed bucket for anything not explicitly known — treated the
// same as "blocked" by callers (not a text conflict an LLM could fix, surface to a human).
export type MergeabilityState =
	| "clean"
	| "hasHooks"
	| "draft"
	| "behind"
	| "dirty"
	| "blocked"
	| "unstable"
	| "unknownPending"
	| "unrecognized";

export interface MergeabilityResult {
	state: MergeabilityState;
	// True when the head branch lives in a different repo than the base (a fork), or that
	// repo no longer exists — either way, an installation on the base repo can't write to
	// it, so resolution must bail rather than attempt a commit that will 403/404.
	isFork: boolean;
	// True when GitHub already merged this PR (out of band, or a prior queue attempt that
	// merged but crashed before persisting mergedPrIds). GitHub never resolves
	// mergeable_state away from "unknown" for a closed/merged PR, so this must be checked
	// before anything looks at `state`, or a merged PR reads as a stuck "unknownPending".
	merged: boolean;
	// True when GitHub's PR state is "closed" and it wasn't merged — i.e. rejected/abandoned
	// on GitHub directly rather than through Quire. Optional: only the real client populates
	// it (see octokitClient.ts); callers that don't need it (existing mergeability checks,
	// test fixtures) can omit it, and it's read only by MergeQueue.reconcileWithGitHub's
	// webhook-miss safety net.
	closed?: boolean;
	headBranch: string;
	headSha: string;
	baseBranch: string;
	baseSha: string;
}

export interface TreeEntry {
	// "blob" (file) or "commit" (submodule) — subdirectory "tree" entries are never surfaced
	// here since trees are fetched recursively and flattened to file-bearing paths only.
	type: "blob" | "commit";
	mode: string;
	sha: string;
}

export interface ConflictTrees {
	mergeBaseSha: string;
	baseSha: string;
	headSha: string;
	// path -> entry, one map per side of the three-way merge. A path absent from a map means
	// the file didn't exist in that tree (deleted there, or added on another side).
	mergeBaseTree: ReadonlyMap<string, TreeEntry>;
	baseTree: ReadonlyMap<string, TreeEntry>;
	headTree: ReadonlyMap<string, TreeEntry>;
}

export interface ResolvedFile {
	path: string;
	content: string;
	// Preserved from the tree entry being replaced (e.g. "100644", "100755") rather than
	// assumed, so resolving a conflict never silently drops an executable bit.
	mode: string;
}

// Thrown by commitResolvedFiles when updating the head ref isn't a fast-forward (someone
// pushed to the PR branch while resolution was in flight) — distinct from other failures so
// the caller can retry once instead of treating it as an unresolvable conflict.
export class NotFastForwardError extends Error {}
