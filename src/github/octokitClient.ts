import type { Octokit } from "@octokit/rest";
import type { GitHubClient, RawPRPayload } from "./client.js";

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

	async listOpenPullRequests(owner: string, repo: string): Promise<ReadonlyArray<RawPRPayload>> {
		const prs = await this.octokit.paginate(this.octokit.rest.pulls.list, { owner, repo, state: "open" });
		const results = await Promise.allSettled(prs.map((pr) => this.toRawPRPayload(owner, repo, pr)));

		const payloads: RawPRPayload[] = [];
		for (const [i, result] of results.entries()) {
			if (result.status === "fulfilled") {
				payloads.push(result.value);
			} else {
				// One PR's failure (e.g. a missing declared-direction marker) must not
				// take down ingestion for every other open PR in the same repo.
				console.error(`Skipping ${owner}/${repo}#${prs[i]?.number}: ${String(result.reason)}`);
			}
		}
		return payloads;
	}

	async mergePullRequest(owner: string, repo: string, prNumber: number): Promise<void> {
		await this.octokit.rest.pulls.merge({ owner, repo, pull_number: prNumber });
	}

	async revertPullRequest(owner: string, repo: string, prNumber: number): Promise<string> {
		const { data: pr } = await this.octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
		const result = await this.octokit.graphql<RevertPullRequestResponse>(REVERT_PULL_REQUEST_MUTATION, {
			pullRequestId: pr.node_id,
		});
		return result.revertPullRequest.pullRequest.url;
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
		const checkRuns = await this.octokit.paginate(this.octokit.rest.checks.listForRef, { owner, repo, ref });
		if (checkRuns.length === 0) return "unknown";
		if (checkRuns.some((run) => run.status !== "completed")) return "pending";
		const failed = new Set(["failure", "timed_out", "cancelled", "action_required", "stale"]);
		if (checkRuns.some((run) => run.conclusion !== null && failed.has(run.conclusion))) return "failure";
		return "success";
	}
}
