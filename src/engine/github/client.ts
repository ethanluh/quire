import type { GestureAction, ReviewCard } from "../types/core.js";
import type { ConflictTrees, MergeabilityResult, ResolvedFile } from "../types/mergeability.js";

export interface RawPRPayload {
	id: string;
	number: number;
	owner: string;
	repo: string;
	title: string;
	body: string;
	headSha: string;
	diff: string;
	ciStatus: "success" | "failure" | "pending" | "unknown";
	declaredDirection: string;
	filesTouched: ReadonlyArray<string>;
}

export interface SkippedPullRequest {
	number: number;
	reason: string;
}

export interface ListOpenPullRequestsResult {
	payloads: ReadonlyArray<RawPRPayload>;
	// PRs that exist but couldn't be turned into a RawPRPayload (most commonly: no
	// declared-direction marker in the body, INV-1's fail-closed case) — surfaced so a
	// caller can tell "nothing to ingest" apart from "N PRs were silently excluded".
	skipped: ReadonlyArray<SkippedPullRequest>;
}

export interface RepoFile {
	content: string;
	sha: string;
}

export interface FoundOrCreatedPullRequest {
	number: number;
	url: string;
	created: boolean;
}

export interface ConflictResolutionDispatchParams {
	prNumber: number;
	headBranch: string;
	baseBranch: string;
	declaredDirection: string;
	callbackUrl: string;
	callbackToken: string;
}

export interface ConflictResolutionDispatchResult {
	// workflow_dispatch's REST response carries no body, so the run it created isn't known
	// synchronously — this is a best-effort recovery, absent if inconclusive.
	workflowRunId?: number;
}

export interface GitHubClient {
	getPullRequest(owner: string, repo: string, prNumber: number): Promise<RawPRPayload>;
	listOpenPullRequests(owner: string, repo: string): Promise<ListOpenPullRequestsResult>;
	mergePullRequest(owner: string, repo: string, prNumber: number): Promise<void>;
	closePullRequest(owner: string, repo: string, prNumber: number): Promise<void>;
	revertPullRequest(owner: string, repo: string, prNumber: number): Promise<string>;
	postReviewCardComment(
		owner: string,
		repo: string,
		prNumber: number,
		action: GestureAction,
		card: ReviewCard,
	): Promise<void>;
	// undefined on a 404 — "no such file", not an error condition callers need to catch.
	getFileContent(owner: string, repo: string, path: string): Promise<RepoFile | undefined>;
	getDefaultBranch(owner: string, repo: string): Promise<string>;
	// Creates `branch` from the default branch if it doesn't exist yet, then commits the
	// file to it. Idempotent: safe to call again for the same branch/path.
	commitFileToBranch(
		owner: string,
		repo: string,
		branch: string,
		path: string,
		content: string,
		message: string,
	): Promise<void>;
	// Returns the existing open PR for `head` if one exists, otherwise opens a new one.
	findOrCreatePullRequest(
		owner: string,
		repo: string,
		params: { head: string; base: string; title: string; body: string },
	): Promise<FoundOrCreatedPullRequest>;
	// GitHub's own "not mergeable" reason, normalized — see types/mergeability.ts. Also
	// carries head/base repo+branch+sha so callers can detect a fork (can't write to it)
	// without a second API call.
	getMergeability(owner: string, repo: string, prNumber: number): Promise<MergeabilityResult>;
	// GitHub's native "Update branch" — merges the base branch into the PR's head branch
	// server-side. No-op if already up to date. Throws if this itself hits a real conflict.
	updateBranch(owner: string, repo: string, prNumber: number): Promise<void>;
	// The three trees (merge-base, base-tip, head-tip) needed for a three-way merge, fetched
	// once each rather than per-file — see types/mergeability.ts's ConflictTrees.
	getConflictTrees(owner: string, repo: string, prNumber: number): Promise<ConflictTrees>;
	// Decoded text content of a blob. Throws BinaryFileError if the blob isn't valid UTF-8.
	getBlobContent(owner: string, repo: string, sha: string): Promise<string>;
	// Commits already-resolved file contents to the PR's head branch as a two-parent merge
	// commit (current head + current base tip), making the PR mergeable again. Throws
	// NotFastForwardError if the head branch moved since getConflictTrees was called.
	commitResolvedFiles(
		owner: string,
		repo: string,
		prNumber: number,
		baseTipSha: string,
		files: ReadonlyArray<ResolvedFile>,
	): Promise<void>;
	// Triggers the target repo's conflict-resolution workflow (see repoSetup.ts) via
	// workflow_dispatch, passing everything the workflow needs to reproduce and resolve the
	// conflict itself. Does not wait for the run to finish — the run reports back via
	// callbackUrl (see routes/actionCallback.ts), with a timeout poll as a fallback. Throws
	// if the workflow file doesn't exist on the default branch yet (repo setup PR not merged).
	dispatchConflictResolution(
		owner: string,
		repo: string,
		params: ConflictResolutionDispatchParams,
	): Promise<ConflictResolutionDispatchResult>;
}

// Content that couldn't be decoded as UTF-8 text — a binary file. Conflict resolution
// bails immediately on these rather than running diff3/an LLM over mangled bytes.
export class BinaryFileError extends Error {}
