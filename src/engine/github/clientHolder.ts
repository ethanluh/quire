import type { GestureAction, ReviewCard } from "../types/core.js";
import type { FoundOrCreatedPullRequest, GitHubClient, ListOpenPullRequestsResult, RawPRPayload, RepoFile } from "./client.js";

// MergeQueue is constructed once at startup holding a reference to a GitHubClient.
// Connecting/disconnecting an account needs to change which client that reference
// resolves to without restarting the process, so the holder is the indirection point:
// it implements GitHubClient itself and forwards every call to whichever client is
// current at call time.
export class GitHubClientHolder implements GitHubClient {
	private current: GitHubClient;

	constructor(initial: GitHubClient) {
		this.current = initial;
	}

	setClient(client: GitHubClient): void {
		this.current = client;
	}

	getPullRequest(owner: string, repo: string, prNumber: number): Promise<RawPRPayload> {
		return this.current.getPullRequest(owner, repo, prNumber);
	}

	listOpenPullRequests(owner: string, repo: string): Promise<ListOpenPullRequestsResult> {
		return this.current.listOpenPullRequests(owner, repo);
	}

	mergePullRequest(owner: string, repo: string, prNumber: number): Promise<void> {
		return this.current.mergePullRequest(owner, repo, prNumber);
	}

	closePullRequest(owner: string, repo: string, prNumber: number): Promise<void> {
		return this.current.closePullRequest(owner, repo, prNumber);
	}

	revertPullRequest(owner: string, repo: string, prNumber: number): Promise<string> {
		return this.current.revertPullRequest(owner, repo, prNumber);
	}

	postReviewCardComment(
		owner: string,
		repo: string,
		prNumber: number,
		action: GestureAction,
		card: ReviewCard,
	): Promise<void> {
		return this.current.postReviewCardComment(owner, repo, prNumber, action, card);
	}

	getFileContent(owner: string, repo: string, path: string): Promise<RepoFile | undefined> {
		return this.current.getFileContent(owner, repo, path);
	}

	getDefaultBranch(owner: string, repo: string): Promise<string> {
		return this.current.getDefaultBranch(owner, repo);
	}

	commitFileToBranch(
		owner: string,
		repo: string,
		branch: string,
		path: string,
		content: string,
		message: string,
	): Promise<void> {
		return this.current.commitFileToBranch(owner, repo, branch, path, content, message);
	}

	findOrCreatePullRequest(
		owner: string,
		repo: string,
		params: { head: string; base: string; title: string; body: string },
	): Promise<FoundOrCreatedPullRequest> {
		return this.current.findOrCreatePullRequest(owner, repo, params);
	}
}
