import type { GestureAction, ReviewCard } from "../types/core.js";

export interface RawPRPayload {
	id: string;
	number: number;
	owner: string;
	repo: string;
	title: string;
	body: string;
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

export interface CreatedWebhook {
	id: number;
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
	createWebhook(owner: string, repo: string, config: { url: string; secret: string }): Promise<CreatedWebhook>;
	deleteWebhook(owner: string, repo: string, hookId: number): Promise<void>;
}
