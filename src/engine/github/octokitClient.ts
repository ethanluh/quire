import type { Octokit } from "@octokit/rest";
import type { GestureAction, ReviewCard } from "../types/core.js";
import { formatReviewCardComment } from "../review/comment.js";
import type { FoundOrCreatedPullRequest, GitHubClient, ListOpenPullRequestsResult, RawPRPayload, RepoFile } from "./client.js";

// Convention assumed for Open Decision #10 (engineering-handoff.md §10): the swarm
// declares direction in an HTML comment so it renders invisibly in the PR body.
const DECLARED_DIRECTION_MARKER = /<!--\s*declared-direction:\s*([\s\S]*?)\s*-->/i;

const REVERT_PULL_REQUEST_MUTATION = `
	mutation revertPullRequest($pullRequestId: ID!) {
		revertPullRequest(input: { pullRequestId: $pullRequestId }) {
			pullRequest {
				url
			}
		}
	}
`;

const MARK_PULL_REQUEST_READY_FOR_REVIEW_MUTATION = `
	mutation markPullRequestReadyForReview($pullRequestId: ID!) {
		markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {
			pullRequest {
				id
			}
		}
	}
`;

interface RevertPullRequestResponse {
	revertPullRequest: {
		pullRequest: {
			url: string;
		};
	};
}

interface PullRequestRef {
	id: number;
	number: number;
	title: string;
	body: string | null;
	head: { sha: string };
}

// Each item's per-PR work (diff + files + CI status, several API calls apiece) is
// independent, but listing every open PR in a repo unbounded would fan out to GitHub
// all at once — cap how many run concurrently to stay clear of secondary rate limits.
const MAX_CONCURRENT_PR_FETCHES = 5;

async function mapWithConcurrency<T, R>(
	items: ReadonlyArray<T>,
	limit: number,
	fn: (item: T) => Promise<R>,
): Promise<ReadonlyArray<PromiseSettledResult<R>>> {
	const results: PromiseSettledResult<R>[] = new Array(items.length);
	let next = 0;

	async function worker(): Promise<void> {
		while (next < items.length) {
			const index = next++;
			const item = items[index] as T;
			try {
				results[index] = { status: "fulfilled", value: await fn(item) };
			} catch (reason) {
				results[index] = { status: "rejected", reason };
			}
		}
	}

	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

function isNotFoundError(err: unknown): boolean {
	return typeof err === "object" && err !== null && "status" in err && (err as { status: unknown }).status === 404;
}

function extractDeclaredDirection(body: string | null, owner: string, repo: string, prNumber: number): string {
	const match = body !== null ? DECLARED_DIRECTION_MARKER.exec(body) : null;
	const direction = match?.[1]?.trim();
	if (direction === undefined || direction.length === 0) {
		// INV-1: a verdict needs an explicit declared prior, never an inferred one.
		throw new Error(
			`${owner}/${repo}#${prNumber} has no <!-- declared-direction: ... --> marker in its body`,
		);
	}
	return direction;
}

export class OctokitGitHubClient implements GitHubClient {
	constructor(private readonly octokit: Octokit) {}

	async getPullRequest(owner: string, repo: string, prNumber: number): Promise<RawPRPayload> {
		const { data: pr } = await this.octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
		return this.toRawPRPayload(owner, repo, pr);
	}

	async listOpenPullRequests(owner: string, repo: string): Promise<ListOpenPullRequestsResult> {
		const prs = await this.octokit.paginate(this.octokit.rest.pulls.list, { owner, repo, state: "open" });
		const results = await mapWithConcurrency(prs, MAX_CONCURRENT_PR_FETCHES, (pr) =>
			this.toRawPRPayload(owner, repo, pr),
		);

		const payloads: RawPRPayload[] = [];
		const skipped: { number: number; reason: string }[] = [];
		for (const [i, result] of results.entries()) {
			if (result.status === "fulfilled") {
				payloads.push(result.value);
			} else {
				// One PR's failure (e.g. a missing declared-direction marker) must not
				// take down ingestion for every other open PR in the same repo — but the
				// caller still needs to know it happened instead of seeing an empty queue
				// with no explanation.
				const reason = String(result.reason);
				console.error(`Skipping ${owner}/${repo}#${prs[i]?.number}: ${reason}`);
				skipped.push({ number: prs[i]?.number ?? -1, reason });
			}
		}
		return { payloads, skipped };
	}

	async mergePullRequest(owner: string, repo: string, prNumber: number): Promise<void> {
		const { data: pr } = await this.octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
		if (pr.draft === true) {
			await this.octokit.graphql(MARK_PULL_REQUEST_READY_FOR_REVIEW_MUTATION, { pullRequestId: pr.node_id });
		}
		await this.octokit.rest.pulls.merge({ owner, repo, pull_number: prNumber });
	}

	async closePullRequest(owner: string, repo: string, prNumber: number): Promise<void> {
		await this.octokit.rest.pulls.update({ owner, repo, pull_number: prNumber, state: "closed" });
	}

	async revertPullRequest(owner: string, repo: string, prNumber: number): Promise<string> {
		const { data: pr } = await this.octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
		const result = await this.octokit.graphql<RevertPullRequestResponse>(REVERT_PULL_REQUEST_MUTATION, {
			pullRequestId: pr.node_id,
		});
		return result.revertPullRequest.pullRequest.url;
	}

	async postReviewCardComment(
		owner: string,
		repo: string,
		prNumber: number,
		action: GestureAction,
		card: ReviewCard,
	): Promise<void> {
		await this.octokit.rest.issues.createComment({
			owner,
			repo,
			issue_number: prNumber,
			body: formatReviewCardComment(action, card),
		});
	}

	async getFileContent(owner: string, repo: string, path: string): Promise<RepoFile | undefined> {
		return this.getFileContentAtRef(owner, repo, path, undefined);
	}

	async getDefaultBranch(owner: string, repo: string): Promise<string> {
		const { data } = await this.octokit.rest.repos.get({ owner, repo });
		return data.default_branch;
	}

	async commitFileToBranch(
		owner: string,
		repo: string,
		branch: string,
		path: string,
		content: string,
		message: string,
	): Promise<void> {
		const branchRef = `heads/${branch}`;
		try {
			await this.octokit.rest.git.getRef({ owner, repo, ref: branchRef });
		} catch (err) {
			if (!isNotFoundError(err)) throw err;
			const defaultBranch = await this.getDefaultBranch(owner, repo);
			const { data: defaultRef } = await this.octokit.rest.git.getRef({ owner, repo, ref: `heads/${defaultBranch}` });
			await this.octokit.rest.git.createRef({ owner, repo, ref: `refs/${branchRef}`, sha: defaultRef.object.sha });
		}

		const existing = await this.getFileContentAtRef(owner, repo, path, branch);
		await this.octokit.rest.repos.createOrUpdateFileContents({
			owner,
			repo,
			path,
			message,
			content: Buffer.from(content, "utf8").toString("base64"),
			branch,
			...(existing !== undefined ? { sha: existing.sha } : {}),
		});
	}

	async findOrCreatePullRequest(
		owner: string,
		repo: string,
		params: { head: string; base: string; title: string; body: string },
	): Promise<FoundOrCreatedPullRequest> {
		const { data: openPrs } = await this.octokit.rest.pulls.list({
			owner,
			repo,
			state: "open",
			head: `${owner}:${params.head}`,
		});
		const found = openPrs[0];
		if (found !== undefined) {
			return { number: found.number, url: found.html_url, created: false };
		}

		const { data: created } = await this.octokit.rest.pulls.create({
			owner,
			repo,
			head: params.head,
			base: params.base,
			title: params.title,
			body: params.body,
		});
		return { number: created.number, url: created.html_url, created: true };
	}

	private async getFileContentAtRef(
		owner: string,
		repo: string,
		path: string,
		ref: string | undefined,
	): Promise<RepoFile | undefined> {
		try {
			const { data } = await this.octokit.rest.repos.getContent({ owner, repo, path, ...(ref !== undefined ? { ref } : {}) });
			if (Array.isArray(data) || data.type !== "file") {
				throw new Error(`${owner}/${repo}: ${path} is not a file`);
			}
			return { content: Buffer.from(data.content, "base64").toString("utf8"), sha: data.sha };
		} catch (err) {
			if (isNotFoundError(err)) return undefined;
			throw err;
		}
	}

	private async toRawPRPayload(owner: string, repo: string, pr: PullRequestRef): Promise<RawPRPayload> {
		const [diffResponse, files, ciStatus] = await Promise.all([
			// The `pulls.get` response type doesn't vary with `mediaType`, but requesting
			// the diff format makes `data` a raw unified-diff string at runtime.
			this.octokit.rest.pulls.get({
				owner,
				repo,
				pull_number: pr.number,
				mediaType: { format: "diff" },
			}) as Promise<{ data: unknown }>,
			this.octokit.paginate(this.octokit.rest.pulls.listFiles, { owner, repo, pull_number: pr.number }),
			this.ciStatusForRef(owner, repo, pr.head.sha),
		]);

		return {
			id: String(pr.id),
			number: pr.number,
			owner,
			repo,
			title: pr.title,
			body: pr.body ?? "",
			headSha: pr.head.sha,
			diff: diffResponse.data as string,
			ciStatus,
			declaredDirection: extractDeclaredDirection(pr.body, owner, repo, pr.number),
			filesTouched: files.map((f) => f.filename),
		};
	}

	private async ciStatusForRef(
		owner: string,
		repo: string,
		ref: string,
	): Promise<RawPRPayload["ciStatus"]> {
		// CI can be reported via either the Checks API (GitHub Actions, most modern
		// integrations) or the legacy Commit Status API (third-party CI predating
		// Checks) — read both, since trusting only one silently hides the other.
		const [checkRuns, combinedStatus] = await Promise.all([
			this.octokit.paginate(this.octokit.rest.checks.listForRef, { owner, repo, ref }),
			this.octokit.rest.repos.getCombinedStatusForRef({ owner, repo, ref }).then((r) => r.data),
		]);

		if (checkRuns.length === 0 && combinedStatus.statuses.length === 0) return "unknown";
		if (checkRuns.some((run) => run.status !== "completed")) return "pending";
		if (combinedStatus.state === "pending") return "pending";

		const failed = new Set(["failure", "timed_out", "cancelled", "action_required", "stale"]);
		if (checkRuns.some((run) => run.conclusion !== null && failed.has(run.conclusion))) return "failure";
		if (combinedStatus.state === "failure") return "failure";
		return "success";
	}
}
