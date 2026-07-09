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

// A team can watch several repos, possibly bound through different installations (their
// personal account plus N orgs), and every existing consumer of GitHubClient (MergeQueue,
// gesturesRouter, ingestion, ...) already calls every method with the owner/repo it concerns
// as the first two arguments. That means one dispatching client — resolve which installation
// backs (owner, repo) live, on every call, and forward to that installation's own client — is
// enough to make the whole existing single-client call graph multi-repo-correct with zero
// changes to any of those callers. Lazily builds and caches one underlying client per
// installationId (not per repo), since several repos can share one installation.
export class MultiRepoGitHubClient implements GitHubClient {
	private readonly clients = new Map<number, GitHubClient>();

	constructor(
		private readonly resolveInstallationId: (owner: string, repo: string) => number | undefined,
		private readonly buildClient: (installationId: number) => GitHubClient,
	) {}

	private clientFor(owner: string, repo: string): GitHubClient {
		const installationId = this.resolveInstallationId(owner, repo);
		if (installationId === undefined) {
			throw new Error(`No installation bound for ${owner}/${repo} — was it removed from the team's repo list?`);
		}
		let client = this.clients.get(installationId);
		if (client === undefined) {
			client = this.buildClient(installationId);
			this.clients.set(installationId, client);
		}
		return client;
	}

	getPullRequest(owner: string, repo: string, prNumber: number): Promise<RawPRPayload> {
		return this.clientFor(owner, repo).getPullRequest(owner, repo, prNumber);
	}

	listOpenPullRequests(owner: string, repo: string): Promise<ListOpenPullRequestsResult> {
		return this.clientFor(owner, repo).listOpenPullRequests(owner, repo);
	}

	mergePullRequest(owner: string, repo: string, prNumber: number): Promise<{ sha: string }> {
		return this.clientFor(owner, repo).mergePullRequest(owner, repo, prNumber);
	}

	closePullRequest(owner: string, repo: string, prNumber: number): Promise<void> {
		return this.clientFor(owner, repo).closePullRequest(owner, repo, prNumber);
	}

	revertPullRequest(owner: string, repo: string, prNumber: number): Promise<string> {
		return this.clientFor(owner, repo).revertPullRequest(owner, repo, prNumber);
	}

	postReviewCardComment(
		owner: string,
		repo: string,
		prNumber: number,
		action: GestureAction,
		card: ReviewCard,
	): Promise<void> {
		return this.clientFor(owner, repo).postReviewCardComment(owner, repo, prNumber, action, card);
	}

	postComment(owner: string, repo: string, prNumber: number, body: string): Promise<void> {
		return this.clientFor(owner, repo).postComment(owner, repo, prNumber, body);
	}

	getFileContent(owner: string, repo: string, path: string): Promise<RepoFile | undefined> {
		return this.clientFor(owner, repo).getFileContent(owner, repo, path);
	}

	getDefaultBranch(owner: string, repo: string): Promise<string> {
		return this.clientFor(owner, repo).getDefaultBranch(owner, repo);
	}

	getIssue(owner: string, repo: string, issueNumber: number): Promise<IssueSummary | undefined> {
		return this.clientFor(owner, repo).getIssue(owner, repo, issueNumber);
	}

	commitFileToBranch(
		owner: string,
		repo: string,
		branch: string,
		path: string,
		content: string,
		message: string,
	): Promise<void> {
		return this.clientFor(owner, repo).commitFileToBranch(owner, repo, branch, path, content, message);
	}

	findOrCreatePullRequest(
		owner: string,
		repo: string,
		params: { head: string; base: string; title: string; body: string },
	): Promise<FoundOrCreatedPullRequest> {
		return this.clientFor(owner, repo).findOrCreatePullRequest(owner, repo, params);
	}

	getMergeability(owner: string, repo: string, prNumber: number): Promise<MergeabilityResult> {
		return this.clientFor(owner, repo).getMergeability(owner, repo, prNumber);
	}

	updateBranch(owner: string, repo: string, prNumber: number): Promise<void> {
		return this.clientFor(owner, repo).updateBranch(owner, repo, prNumber);
	}

	getConflictTrees(owner: string, repo: string, prNumber: number): Promise<ConflictTrees> {
		return this.clientFor(owner, repo).getConflictTrees(owner, repo, prNumber);
	}

	getBlobContent(owner: string, repo: string, sha: string): Promise<string> {
		return this.clientFor(owner, repo).getBlobContent(owner, repo, sha);
	}

	commitResolvedFiles(
		owner: string,
		repo: string,
		prNumber: number,
		baseTipSha: string,
		files: ReadonlyArray<ResolvedFile>,
	): Promise<void> {
		return this.clientFor(owner, repo).commitResolvedFiles(owner, repo, prNumber, baseTipSha, files);
	}
}
