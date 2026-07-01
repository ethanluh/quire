import type { GestureAction, ReviewCard } from "../types/core.js";
import type { GitHubClient, RawPRPayload } from "./client.js";

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

	listOpenPullRequests(owner: string, repo: string): Promise<ReadonlyArray<RawPRPayload>> {
		return this.current.listOpenPullRequests(owner, repo);
	}

	mergePullRequest(owner: string, repo: string, prNumber: number): Promise<void> {
		return this.current.mergePullRequest(owner, repo, prNumber);
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
}
