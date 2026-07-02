import type { GestureAction, ReviewCard } from "../types/core.js";
import type { CreatedWebhook, GitHubClient, ListOpenPullRequestsResult, RawPRPayload } from "./client.js";

export interface PostedReviewCardComment {
	owner: string;
	repo: string;
	prNumber: number;
	action: GestureAction;
	card: ReviewCard;
}

export interface CreatedWebhookRecord {
	owner: string;
	repo: string;
	url: string;
	id: number;
}

export interface DeletedWebhookRecord {
	owner: string;
	repo: string;
	hookId: number;
}

export class StubGitHubClient implements GitHubClient {
	private readonly prFixtures: Map<string, RawPRPayload> = new Map();
	readonly mergedPrs: string[] = [];
	readonly closedPrs: string[] = [];
	readonly revertedPrs: string[] = [];
	readonly postedReviewCardComments: PostedReviewCardComment[] = [];
	readonly createdWebhooks: CreatedWebhookRecord[] = [];
	readonly deletedWebhooks: DeletedWebhookRecord[] = [];
	private nextWebhookId = 1;

	addFixture(owner: string, repo: string, pr: RawPRPayload): void {
		this.prFixtures.set(`${owner}/${repo}/${pr.number}`, pr);
	}

	async getPullRequest(owner: string, repo: string, prNumber: number): Promise<RawPRPayload> {
		const key = `${owner}/${repo}/${prNumber}`;
		const fixture = this.prFixtures.get(key);
		if (fixture === undefined) throw new Error(`No fixture for ${key}`);
		return fixture;
	}

	async listOpenPullRequests(owner: string, repo: string): Promise<ListOpenPullRequestsResult> {
		const prefix = `${owner}/${repo}/`;
		const payloads = [...this.prFixtures.entries()]
			.filter(([k]) => k.startsWith(prefix))
			.map(([, v]) => v);
		return { payloads, skipped: [] };
	}

	async mergePullRequest(owner: string, repo: string, prNumber: number): Promise<void> {
		this.mergedPrs.push(`${owner}/${repo}/${prNumber}`);
	}

	async closePullRequest(owner: string, repo: string, prNumber: number): Promise<void> {
		this.closedPrs.push(`${owner}/${repo}/${prNumber}`);
	}

	async revertPullRequest(owner: string, repo: string, prNumber: number): Promise<string> {
		this.revertedPrs.push(`${owner}/${repo}/${prNumber}`);
		return `https://github.com/${owner}/${repo}/pull/999`;
	}

	async postReviewCardComment(
		owner: string,
		repo: string,
		prNumber: number,
		action: GestureAction,
		card: ReviewCard,
	): Promise<void> {
		this.postedReviewCardComments.push({ owner, repo, prNumber, action, card });
	}

	async createWebhook(owner: string, repo: string, config: { url: string; secret: string }): Promise<CreatedWebhook> {
		const id = this.nextWebhookId++;
		this.createdWebhooks.push({ owner, repo, url: config.url, id });
		return { id };
	}

	async deleteWebhook(owner: string, repo: string, hookId: number): Promise<void> {
		this.deletedWebhooks.push({ owner, repo, hookId });
	}
}
