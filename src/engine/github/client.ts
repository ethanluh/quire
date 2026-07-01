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

export interface GitHubClient {
	getPullRequest(owner: string, repo: string, prNumber: number): Promise<RawPRPayload>;
	listOpenPullRequests(owner: string, repo: string): Promise<ReadonlyArray<RawPRPayload>>;
	mergePullRequest(owner: string, repo: string, prNumber: number): Promise<void>;
	revertPullRequest(owner: string, repo: string, prNumber: number): Promise<string>;
	postReviewCardComment(
		owner: string,
		repo: string,
		prNumber: number,
		action: GestureAction,
		card: ReviewCard,
	): Promise<void>;
}
