import type { GestureAction, ReviewCard } from "../types/core.js";

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
}
