import type { GestureAction, ReviewCard } from "../types/core.js";
import type {
	FoundOrCreatedPullRequest,
	GitHubClient,
	IssueSummary,
	ListOpenPullRequestsResult,
	RawPRPayload,
	RepoFile,
} from "./client.js";
import type { ConflictTrees, MergeabilityResult, ResolvedFile } from "../types/mergeability.js";

export interface CommitResolvedFilesCall {
	owner: string;
	repo: string;
	prNumber: number;
	baseTipSha: string;
	files: ReadonlyArray<ResolvedFile>;
}

export interface PostedReviewCardComment {
	owner: string;
	repo: string;
	prNumber: number;
	action: GestureAction;
	card: ReviewCard;
}

export interface PostedComment {
	owner: string;
	repo: string;
	prNumber: number;
	body: string;
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
	private readonly mergeabilityFixtures: Map<string, MergeabilityResult> = new Map();
	private readonly issueFixtures: Map<string, IssueSummary> = new Map();
	private readonly conflictTreesFixtures: Map<string, ConflictTrees> = new Map();
	private readonly blobFixtures: Map<string, string> = new Map();
	readonly mergedPrs: string[] = [];
	readonly closedPrs: string[] = [];
	readonly revertedPrs: string[] = [];
	readonly postedReviewCardComments: PostedReviewCardComment[] = [];
	readonly postedComments: PostedComment[] = [];
	readonly updateBranchCalls: string[] = [];
	readonly commitResolvedFilesCalls: CommitResolvedFilesCall[] = [];
	// One-shot: thrown on the next call, then cleared, so a test can simulate a single
	// transient failure (e.g. a non-fast-forward race) without permanently breaking the stub.
	updateBranchError: Error | undefined;
	commitResolvedFilesError: Error | undefined;
	// One-shot, like the others — simulates mergePullRequest throwing (e.g. a response
	// timeout) after GitHub may or may not have actually committed the merge server-side.
	mergePullRequestError: Error | undefined;
	// When mergePullRequestError is set, controls whether the merge is treated as having
	// actually gone through on GitHub's side despite the thrown error — flips the fixture's
	// own mergeability record to merged, same as a real merge would, so getMergeability()
	// called during error recovery sees it.
	mergePullRequestErrorButActuallyMerged = false;
	// Set false to simulate updateBranch/commitResolvedFiles succeeding but the PR staying
	// not-mergeable anyway (e.g. the base branch moved again during resolution).
	autoMarkMergeableAfterSuccess = true;

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

	// Defaults to "clean" when unset so every existing test exercising mergePullRequest
	// through dequeueNext() keeps working unchanged — only conflict-resolution tests need
	// to call this.
	setMergeability(owner: string, repo: string, prNumber: number, result: MergeabilityResult): void {
		this.mergeabilityFixtures.set(`${owner}/${repo}/${prNumber}`, result);
	}

	setConflictTrees(owner: string, repo: string, prNumber: number, trees: ConflictTrees): void {
		this.conflictTreesFixtures.set(`${owner}/${repo}/${prNumber}`, trees);
	}

	setBlobContent(sha: string, content: string): void {
		this.blobFixtures.set(sha, content);
	}

	// Unset (or unmatched issueNumber) mirrors a 404: getIssue() returns undefined.
	setIssue(owner: string, repo: string, issueNumber: number, issue: IssueSummary): void {
		this.issueFixtures.set(`${owner}/${repo}/${issueNumber}`, issue);
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
		if (this.mergePullRequestError !== undefined) {
			const err = this.mergePullRequestError;
			this.mergePullRequestError = undefined;
			if (this.mergePullRequestErrorButActuallyMerged) {
				const key = `${owner}/${repo}/${prNumber}`;
				const current = this.mergeabilityFixtures.get(key) ?? {
					state: "clean" as const,
					isFork: false,
					merged: false,
					headBranch: "head",
					headSha: "head-sha",
					baseBranch: "base",
					baseSha: "base-sha",
				};
				this.mergeabilityFixtures.set(key, { ...current, merged: true });
			}
			throw err;
		}
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

	async postComment(owner: string, repo: string, prNumber: number, body: string): Promise<void> {
		this.postedComments.push({ owner, repo, prNumber, body });
	}

	async getFileContent(owner: string, repo: string, path: string): Promise<RepoFile | undefined> {
		return this.filesFor(owner, repo, this.defaultBranch).get(path);
	}

	async getDefaultBranch(_owner: string, _repo: string): Promise<string> {
		return this.defaultBranch;
	}

	async getIssue(owner: string, repo: string, issueNumber: number): Promise<IssueSummary | undefined> {
		return this.issueFixtures.get(`${owner}/${repo}/${issueNumber}`);
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

	async getMergeability(owner: string, repo: string, prNumber: number): Promise<MergeabilityResult> {
		const key = `${owner}/${repo}/${prNumber}`;
		return (
			this.mergeabilityFixtures.get(key) ?? {
				state: "clean",
				isFork: false,
				merged: false,
				headBranch: "head",
				headSha: "head-sha",
				baseBranch: "base",
				baseSha: "base-sha",
			}
		);
	}

	async updateBranch(owner: string, repo: string, prNumber: number): Promise<void> {
		this.updateBranchCalls.push(`${owner}/${repo}/${prNumber}`);
		if (this.updateBranchError !== undefined) {
			const err = this.updateBranchError;
			this.updateBranchError = undefined;
			throw err;
		}
		// Mirrors reality: a successful branch update is exactly what makes the PR
		// mergeable again, so the next getMergeability() call should reflect that.
		this.markMergeableAfterSuccess(owner, repo, prNumber);
	}

	async getConflictTrees(owner: string, repo: string, prNumber: number): Promise<ConflictTrees> {
		const key = `${owner}/${repo}/${prNumber}`;
		const fixture = this.conflictTreesFixtures.get(key);
		if (fixture === undefined) throw new Error(`No conflict-trees fixture for ${key}`);
		return fixture;
	}

	async getBlobContent(_owner: string, _repo: string, sha: string): Promise<string> {
		const fixture = this.blobFixtures.get(sha);
		if (fixture === undefined) throw new Error(`No blob fixture for ${sha}`);
		return fixture;
	}

	async commitResolvedFiles(
		owner: string,
		repo: string,
		prNumber: number,
		baseTipSha: string,
		files: ReadonlyArray<ResolvedFile>,
	): Promise<void> {
		this.commitResolvedFilesCalls.push({ owner, repo, prNumber, baseTipSha, files });
		if (this.commitResolvedFilesError !== undefined) {
			const err = this.commitResolvedFilesError;
			this.commitResolvedFilesError = undefined;
			throw err;
		}
		// Mirrors reality: a successful resolution commit is exactly what makes the PR
		// mergeable again, so the next getMergeability() call should reflect that.
		this.markMergeableAfterSuccess(owner, repo, prNumber);
	}

	private markMergeableAfterSuccess(owner: string, repo: string, prNumber: number): void {
		if (!this.autoMarkMergeableAfterSuccess) return;
		const key = `${owner}/${repo}/${prNumber}`;
		const current = this.mergeabilityFixtures.get(key);
		if (current !== undefined) {
			this.mergeabilityFixtures.set(key, { ...current, state: "clean" });
		}
	}
}
