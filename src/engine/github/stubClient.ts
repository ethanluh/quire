import type { GestureAction, ReviewCard } from "../types/core.js";
import type { FoundOrCreatedPullRequest, GitHubClient, ListOpenPullRequestsResult, RawPRPayload, RepoFile } from "./client.js";

export interface PostedReviewCardComment {
	owner: string;
	repo: string;
	prNumber: number;
	action: GestureAction;
	card: ReviewCard;
}

interface StubPullRequest {
	number: number;
	url: string;
	head: string;
	base: string;
	title: string;
	body: string;
	open: boolean;
}

export class StubGitHubClient implements GitHubClient {
	private readonly prFixtures: Map<string, RawPRPayload> = new Map();
	private readonly files: Map<string, Map<string, RepoFile>> = new Map();
	private readonly branches: Map<string, Set<string>> = new Map();
	private readonly pullRequests: Map<string, StubPullRequest[]> = new Map();
	private nextPrNumber = 1000;
	defaultBranch = "main";
	readonly mergedPrs: string[] = [];
	readonly closedPrs: string[] = [];
	readonly revertedPrs: string[] = [];
	readonly postedReviewCardComments: PostedReviewCardComment[] = [];

	addFixture(owner: string, repo: string, pr: RawPRPayload): void {
		this.prFixtures.set(`${owner}/${repo}/${pr.number}`, pr);
	}

	// Seeds a file as if it already existed on the repo's default branch — for tests that
	// need to exercise "template already present" branches of setup logic.
	seedFile(owner: string, repo: string, path: string, content: string): void {
		this.filesFor(owner, repo, this.defaultBranch).set(path, { content, sha: `sha-${this.nextFileSha++}` });
	}

	private nextFileSha = 1;

	private filesFor(owner: string, repo: string, branch: string): Map<string, RepoFile> {
		const key = `${owner}/${repo}#${branch}`;
		let map = this.files.get(key);
		if (map === undefined) {
			map = new Map();
			this.files.set(key, map);
		}
		return map;
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

	async getFileContent(owner: string, repo: string, path: string): Promise<RepoFile | undefined> {
		return this.filesFor(owner, repo, this.defaultBranch).get(path);
	}

	async getDefaultBranch(_owner: string, _repo: string): Promise<string> {
		return this.defaultBranch;
	}

	async commitFileToBranch(
		owner: string,
		repo: string,
		branch: string,
		path: string,
		content: string,
		_message: string,
	): Promise<void> {
		const repoKey = `${owner}/${repo}`;
		const existingBranches = this.branches.get(repoKey) ?? new Set<string>();
		if (branch !== this.defaultBranch && !existingBranches.has(branch)) {
			existingBranches.add(branch);
			this.branches.set(repoKey, existingBranches);
			for (const [seededPath, file] of this.filesFor(owner, repo, this.defaultBranch)) {
				this.filesFor(owner, repo, branch).set(seededPath, file);
			}
		}
		this.filesFor(owner, repo, branch).set(path, { content, sha: `sha-${this.nextFileSha++}` });
	}

	async findOrCreatePullRequest(
		owner: string,
		repo: string,
		params: { head: string; base: string; title: string; body: string },
	): Promise<FoundOrCreatedPullRequest> {
		const repoKey = `${owner}/${repo}`;
		const prs = this.pullRequests.get(repoKey) ?? [];
		const existing = prs.find((pr) => pr.open && pr.head === params.head);
		if (existing !== undefined) {
			return { number: existing.number, url: existing.url, created: false };
		}
		const number = this.nextPrNumber++;
		const url = `https://github.com/${owner}/${repo}/pull/${number}`;
		prs.push({ number, url, head: params.head, base: params.base, title: params.title, body: params.body, open: true });
		this.pullRequests.set(repoKey, prs);
		return { number, url, created: true };
	}
}
