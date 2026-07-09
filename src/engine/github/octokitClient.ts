import type { Octokit } from "@octokit/rest";
import { UNDECLARED_DIRECTION, type GestureAction, type ReviewCard } from "../types/core.js";
import { formatReviewCardComment } from "../review/comment.js";
import type {
	FoundOrCreatedPullRequest,
	GitHubClient,
	IssueSummary,
	ListOpenPullRequestsResult,
	RawPRPayload,
	RepoFile,
} from "./client.js";
import { BinaryFileError } from "./client.js";
import type { ConflictTrees, MergeabilityResult, MergeabilityState, ResolvedFile, TreeEntry } from "../types/mergeability.js";
import { NotFastForwardError } from "../types/mergeability.js";
import { settleWithConcurrency } from "../util/concurrency.js";

// Convention assumed for Open Decision #10 (engineering-handoff.md §10): the swarm
// declares direction in an HTML comment so it renders invisibly in the PR body.
// The capture is length-bounded (not open `[\s\S]*?`): an unbounded lazy group followed by
// `\s*-->` backtracks quadratically over whitespace when the closing `-->` is absent, so a
// PR body of `<!-- declared-direction:` + tens of KB of spaces would burn event-loop CPU on
// the ingest path. Callers additionally skip the regex entirely when no `-->` is present.
const DECLARED_DIRECTION_MARKER = /<!--\s*declared-direction:\s*([\s\S]{0,10000}?)\s*-->/i;

// GitHub's own closing-keyword set (case-insensitive), same-repo `#<n>` only — matches the
// linking convention documented in this repo's CLAUDE.md ("Closes #<number>").
const CLOSING_KEYWORD_RE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/i;

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

// Exported so other GitHub-error call sites (e.g. collaborators.ts) share this same 404
// detection instead of re-deriving it locally.
export function isNotFoundError(err: unknown): boolean {
	return typeof err === "object" && err !== null && "status" in err && (err as { status: unknown }).status === 404;
}

// Thrown when the GitHub App's installation has read-only access but the call needs
// write (merge/close/revert/comment) — surfaces as a raw, unhelpful 403 from GitHub
// otherwise ("Resource not accessible by integration"). See README's "GitHub App setup".
export class InsufficientGitHubPermissionError extends Error {}

// @octokit/rest depends on a different (transitively-pinned) copy of @octokit/request-error
// than the one this package imports directly, so npm can't dedupe them — real errors from
// this.octokit.rest.* calls are never `instanceof` the class imported here. Both copies set
// `name`/`status` the same way, so duck-type on those instead of on class identity. Exported
// so other GitHub-error call sites (e.g. installationClient.ts) share this same detection
// instead of re-introducing the identity check this bug came from.
export function isHttpError(err: unknown): err is { name: string; status: number; message: string } {
	return err instanceof Error && err.name === "HttpError" && typeof (err as { status?: unknown }).status === "number";
}

// Exported so other GitHub-error call sites (e.g. collaborators.ts's classifyFailure) share
// this same detection instead of re-deriving the same status/message check locally.
export function isInsufficientPermission(err: unknown): boolean {
	return isHttpError(err)
		&& err.status === 403
		&& /Resource not accessible by integration/i.test(err.message);
}

async function withPermissionHint<T>(action: string, fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (err) {
		if (isInsufficientPermission(err)) {
			throw new InsufficientGitHubPermissionError(
				`GitHub App is missing the permission needed to ${action}. See README.md's "GitHub App setup" section for the required permissions, then re-approve the installation.`,
			);
		}
		throw err;
	}
}

// GitHub's `mergeable_state` is an untyped string in Octokit's own schema (it has grown
// new values before) — map it once, here, to the closed union the rest of the codebase
// works with. Anything not explicitly recognized falls into "unrecognized", the same
// fail-closed bucket as "blocked": not something conflict resolution should ever attempt.
function normalizeMergeableState(draft: boolean, mergeableState: string): MergeabilityState {
	if (draft) return "draft";
	switch (mergeableState) {
		case "clean":
			return "clean";
		case "has_hooks":
			return "hasHooks";
		case "behind":
			return "behind";
		case "dirty":
			return "dirty";
		case "blocked":
			return "blocked";
		case "unstable":
			return "unstable";
		case "unknown":
			return "unknownPending";
		default:
			return "unrecognized";
	}
}

// How much of the PR body to fold into the fallback direction when there's no marker —
// enough to carry real signal, short enough to stay a label rather than a full re-read.
const FALLBACK_BODY_MAX_LENGTH = 200;

// Builds a direction label from the PR's own title/body when the author never filled in
// the marker. Still not an explicit declaration (INV-1's discipline) — the caller marks
// the result `inferred: true` so downstream code keeps treating it as "no real evidence,"
// same as the old UNDECLARED_DIRECTION-only behavior, just with a legible label instead
// of an opaque placeholder.
function synthesizeDirectionFromDetails(title: string, body: string | null): string {
	const trimmedTitle = title.trim();
	const trimmedBody = (body ?? "").trim();
	const truncatedBody =
		trimmedBody.length > FALLBACK_BODY_MAX_LENGTH
			? `${trimmedBody.slice(0, FALLBACK_BODY_MAX_LENGTH).trim()}…`
			: trimmedBody;
	if (trimmedTitle.length === 0) return truncatedBody;
	if (truncatedBody.length === 0) return trimmedTitle;
	return `${trimmedTitle}: ${truncatedBody}`;
}

function extractDeclaredDirection(body: string | null, title: string): { direction: string; inferred: boolean } {
	// The `includes` pre-check makes the no-closing-`-->` case (the backtracking-prone one)
	// short-circuit before the regex runs at all.
	const match = body !== null && body.includes("-->") ? DECLARED_DIRECTION_MARKER.exec(body) : null;
	const declared = match?.[1]?.trim();
	if (declared !== undefined && declared.length > 0) {
		return { direction: declared, inferred: false };
	}
	// INV-1: a verdict needs an explicit declared prior, never an inferred one — so a
	// missing marker never gets treated as a real declaration. Rather than an opaque
	// placeholder, fall back to the PR's own title/description when there's one to use;
	// downstream (bundling, gate criteria, spec conformance) keys off `inferred` — never
	// `direction` — to keep this out of any comparison that needs a real declaration.
	const fallback = synthesizeDirectionFromDetails(title, body);
	if (fallback.length > 0) {
		return { direction: fallback, inferred: true };
	}
	return { direction: UNDECLARED_DIRECTION, inferred: true };
}

// Exported for unit tests (octokitClient.test.ts) — the closing-keyword regex is the only
// non-trivial logic here and is worth testing directly rather than only through a full PR fetch.
export function extractLinkedIssueNumber(body: string | null): number | undefined {
	const match = body !== null ? CLOSING_KEYWORD_RE.exec(body) : null;
	return match !== null ? Number(match[1]) : undefined;
}

export class OctokitGitHubClient implements GitHubClient {
	constructor(private readonly octokit: Octokit) {}

	async getPullRequest(owner: string, repo: string, prNumber: number): Promise<RawPRPayload> {
		const { data: pr } = await this.octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
		return this.toRawPRPayload(owner, repo, pr);
	}

	async listOpenPullRequests(owner: string, repo: string): Promise<ListOpenPullRequestsResult> {
		const prs = await this.octokit.paginate(this.octokit.rest.pulls.list, { owner, repo, state: "open" });
		const results = await settleWithConcurrency(prs, MAX_CONCURRENT_PR_FETCHES, (pr) =>
			this.toRawPRPayload(owner, repo, pr),
		);

		const payloads: RawPRPayload[] = [];
		const skipped: { number: number; reason: string }[] = [];
		for (const [i, result] of results.entries()) {
			if (result.status === "fulfilled") {
				payloads.push(result.value);
			} else {
				// One PR's failure (e.g. a diff or file-list fetch error) must not take
				// down ingestion for every other open PR in the same repo — but the
				// caller still needs to know it happened instead of seeing an empty queue
				// with no explanation. A missing declared-direction marker no longer
				// lands here — extractDeclaredDirection() falls back to the PR's title/
				// body (or UNDECLARED_DIRECTION if both are empty) instead of throwing,
				// so that PR still ingests normally.
				const reason = String(result.reason);
				console.error(`Skipping ${owner}/${repo}#${prs[i]?.number}: ${reason}`);
				skipped.push({ number: prs[i]?.number ?? -1, reason });
			}
		}
		return { payloads, skipped };
	}

	async mergePullRequest(owner: string, repo: string, prNumber: number): Promise<{ sha: string }> {
		return withPermissionHint("merge a pull request", async () => {
			const { data: pr } = await this.octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
			if (pr.draft === true) {
				await this.octokit.graphql(MARK_PULL_REQUEST_READY_FOR_REVIEW_MUTATION, { pullRequestId: pr.node_id });
			}
			const { data: merged } = await this.octokit.rest.pulls.merge({ owner, repo, pull_number: prNumber });
			return { sha: merged.sha };
		});
	}

	async closePullRequest(owner: string, repo: string, prNumber: number): Promise<void> {
		await withPermissionHint("close a pull request", () =>
			this.octokit.rest.pulls.update({ owner, repo, pull_number: prNumber, state: "closed" }),
		);
	}

	async revertPullRequest(owner: string, repo: string, prNumber: number): Promise<string> {
		return withPermissionHint("revert a pull request", async () => {
			const { data: pr } = await this.octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
			const result = await this.octokit.graphql<RevertPullRequestResponse>(REVERT_PULL_REQUEST_MUTATION, {
				pullRequestId: pr.node_id,
			});
			return result.revertPullRequest.pullRequest.url;
		});
	}

	async postReviewCardComment(
		owner: string,
		repo: string,
		prNumber: number,
		action: GestureAction,
		card: ReviewCard,
	): Promise<void> {
		await withPermissionHint("post a review card comment", () =>
			this.octokit.rest.issues.createComment({
				owner,
				repo,
				issue_number: prNumber,
				body: formatReviewCardComment(action, card),
			}),
		);
	}

	async postComment(owner: string, repo: string, prNumber: number, body: string): Promise<void> {
		await withPermissionHint("post a comment", () =>
			this.octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body }),
		);
	}

	async getFileContent(owner: string, repo: string, path: string): Promise<RepoFile | undefined> {
		return this.getFileContentAtRef(owner, repo, path, undefined);
	}

	async getDefaultBranch(owner: string, repo: string): Promise<string> {
		const { data } = await this.octokit.rest.repos.get({ owner, repo });
		return data.default_branch;
	}

	async getIssue(owner: string, repo: string, issueNumber: number): Promise<IssueSummary | undefined> {
		try {
			const { data } = await this.octokit.rest.issues.get({ owner, repo, issue_number: issueNumber });
			return { title: data.title, body: data.body ?? null };
		} catch (err) {
			if (isNotFoundError(err)) return undefined;
			throw err;
		}
	}

	async commitFileToBranch(
		owner: string,
		repo: string,
		branch: string,
		path: string,
		content: string,
		message: string,
	): Promise<void> {
		await withPermissionHint("create or update a file in a repo", async () => {
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
		});
	}

	async findOrCreatePullRequest(
		owner: string,
		repo: string,
		params: { head: string; base: string; title: string; body: string },
	): Promise<FoundOrCreatedPullRequest> {
		return withPermissionHint("open a pull request", async () => {
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
		});
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

	async getMergeability(owner: string, repo: string, prNumber: number): Promise<MergeabilityResult> {
		const { data: pr } = await this.octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
		// Repos are nullable in GitHub's schema (deleted fork) — either a null head repo or
		// one with a different id than the base means resolution can't write to it.
		const isFork = pr.head.repo === null || pr.base.repo === null || pr.head.repo.id !== pr.base.repo.id;
		// pr.base.sha is a cached pointer GitHub only refreshes when the PR itself is
		// synchronized (e.g. a push to head) — it silently lags behind the base branch's
		// real tip when other PRs land on it in the meantime. Read the live tip instead.
		const baseSha = await this.getBranchTipSha(owner, repo, pr.base.ref);
		return {
			state: normalizeMergeableState(pr.draft === true, pr.mergeable_state ?? "unknown"),
			isFork,
			merged: pr.merged === true,
			headBranch: pr.head.ref,
			headSha: pr.head.sha,
			baseBranch: pr.base.ref,
			baseSha,
		};
	}

	async updateBranch(owner: string, repo: string, prNumber: number): Promise<void> {
		await this.octokit.rest.pulls.updateBranch({ owner, repo, pull_number: prNumber });
	}

	async getConflictTrees(owner: string, repo: string, prNumber: number): Promise<ConflictTrees> {
		const { data: pr } = await this.octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
		// See getMergeability's comment above — pr.base.sha can lag behind the base
		// branch's real tip, which would make this diff against a stale "theirs".
		const baseSha = await this.getBranchTipSha(owner, repo, pr.base.ref);
		const headSha = pr.head.sha;

		const { data: comparison } = await this.octokit.rest.repos.compareCommitsWithBasehead({
			owner,
			repo,
			basehead: `${baseSha}...${headSha}`,
		});
		const mergeBaseSha = comparison.merge_base_commit.sha;

		const [mergeBaseTree, baseTree, headTree] = await Promise.all([
			this.getFlatTree(owner, repo, mergeBaseSha),
			this.getFlatTree(owner, repo, baseSha),
			this.getFlatTree(owner, repo, headSha),
		]);

		return { mergeBaseSha, baseSha, headSha, mergeBaseTree, baseTree, headTree };
	}

	async getBlobContent(owner: string, repo: string, sha: string): Promise<string> {
		const { data } = await this.octokit.rest.git.getBlob({ owner, repo, file_sha: sha });
		if (data.encoding !== "base64") {
			throw new BinaryFileError(`Blob ${sha} in ${owner}/${repo} had unexpected encoding "${data.encoding}"`);
		}
		const buffer = Buffer.from(data.content, "base64");
		// A null byte anywhere is the same heuristic git itself uses to flag a file binary —
		// text files never legitimately contain one.
		if (buffer.includes(0)) {
			throw new BinaryFileError(`Blob ${sha} in ${owner}/${repo} is binary`);
		}
		return buffer.toString("utf-8");
	}

	async commitResolvedFiles(
		owner: string,
		repo: string,
		prNumber: number,
		baseTipSha: string,
		files: ReadonlyArray<ResolvedFile>,
	): Promise<void> {
		const { data: pr } = await this.octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
		const headSha = pr.head.sha;
		const headBranch = pr.head.ref;

		const { data: headCommit } = await this.octokit.rest.git.getCommit({ owner, repo, commit_sha: headSha });

		const blobs = await Promise.all(
			files.map(async (file) => {
				const { data: blob } = await this.octokit.rest.git.createBlob({
					owner,
					repo,
					content: file.content,
					encoding: "utf-8",
				});
				return { path: file.path, mode: file.mode, sha: blob.sha };
			}),
		);

		// base_tree inherits every untouched path from the head commit's tree — only the
		// resolved files' entries are replaced, nothing else is dropped.
		const { data: newTree } = await this.octokit.rest.git.createTree({
			owner,
			repo,
			base_tree: headCommit.tree.sha,
			tree: blobs.map((b) => ({
				path: b.path,
				mode: b.mode as "100644" | "100755",
				type: "blob",
				sha: b.sha,
			})),
		});

		// Two parents — the PR's current head and the base branch's current tip — is exactly
		// the commit shape a local `git merge <base> && git push` would produce.
		const { data: newCommit } = await this.octokit.rest.git.createCommit({
			owner,
			repo,
			message: "Resolve merge conflict via automated resolution",
			tree: newTree.sha,
			parents: [headSha, baseTipSha],
		});

		try {
			// A merge commit built on top of the current head is a fast-forward from the
			// branch's own perspective, so force:false should succeed unless someone pushed
			// to the PR branch after headSha was read above.
			await this.octokit.rest.git.updateRef({
				owner,
				repo,
				ref: `heads/${headBranch}`,
				sha: newCommit.sha,
				force: false,
			});
		} catch (err) {
			if (isHttpError(err) && (err.status === 422 || err.status === 409)) {
				throw new NotFastForwardError(`${owner}/${repo} branch ${headBranch} moved during conflict resolution`);
			}
			throw err;
		}
	}

	private async getBranchTipSha(owner: string, repo: string, branch: string): Promise<string> {
		const { data } = await this.octokit.rest.git.getRef({ owner, repo, ref: `heads/${branch}` });
		return data.object.sha;
	}

	private async getFlatTree(owner: string, repo: string, treeSha: string): Promise<ReadonlyMap<string, TreeEntry>> {
		const { data } = await this.octokit.rest.git.getTree({ owner, repo, tree_sha: treeSha, recursive: "true" });
		const map = new Map<string, TreeEntry>();
		for (const entry of data.tree) {
			// Subdirectory "tree" entries are skipped — recursive:true already flattens to
			// full file paths, so only "blob" (file) and "commit" (submodule) entries matter.
			if (entry.type !== "blob" && entry.type !== "commit") continue;
			if (entry.path === undefined || entry.sha === undefined || entry.mode === undefined) continue;
			map.set(entry.path, { type: entry.type, mode: entry.mode, sha: entry.sha });
		}
		return map;
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

		const linkedIssueNumber = extractLinkedIssueNumber(pr.body);
		const { direction, inferred } = extractDeclaredDirection(pr.body, pr.title);
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
			declaredDirection: direction,
			directionInferred: inferred,
			...(linkedIssueNumber !== undefined ? { linkedIssueNumber } : {}),
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
