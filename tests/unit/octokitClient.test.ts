import { describe, it, expect, jest } from "@jest/globals";
import type { Octokit } from "@octokit/rest";
import { OctokitGitHubClient, InsufficientGitHubPermissionError, extractLinkedIssueNumber } from "../../src/engine/github/octokitClient.js";
import { UNDECLARED_DIRECTION } from "../../src/engine/types/core.js";

// Deliberately NOT `@octokit/request-error`'s `RequestError`: in production, errors thrown by
// `this.octokit.rest.*` calls come from a different, transitively-pinned copy of that package
// than the one the source file could import, so `instanceof` can never be relied on. This fake
// only replicates the `name`/`status` shape both copies actually set, so these tests exercise
// the same duck-typed detection the real code uses instead of accidentally relying on class
// identity like the bug this fixes did.
class FakeHttpError extends Error {
	readonly status: number;
	constructor(message: string, status: number) {
		super(message);
		this.name = "HttpError";
		this.status = status;
	}
}

function insufficientPermissionError(): FakeHttpError {
	return new FakeHttpError("Resource not accessible by integration", 403);
}

interface FakeCheckRun {
	status: "completed" | "in_progress" | "queued";
	conclusion: string | null;
}

interface FakeCombinedStatus {
	state: "success" | "failure" | "pending";
	statuses: ReadonlyArray<{ state: string }>;
}

function makePrResponse(body: string | null, overrides: Record<string, unknown> = {}) {
	return {
		id: 42,
		number: 7,
		title: "add passwordless auth",
		body,
		node_id: "PR_node123",
		head: { sha: "abc123" },
		labels: [],
		assignees: [],
		...overrides,
	};
}

function notFoundError(): FakeHttpError {
	return new FakeHttpError("Not Found", 404);
}

function makeFakeOctokit(opts: {
	pr?: ReturnType<typeof makePrResponse>;
	listPrs?: ReadonlyArray<ReturnType<typeof makePrResponse>>;
	diff?: string;
	files?: ReadonlyArray<{ filename: string }>;
	checkRuns?: ReadonlyArray<FakeCheckRun>;
	combinedStatus?: FakeCombinedStatus;
	graphqlResult?: unknown;
	mergeRejects?: Error;
	updateRejects?: Error;
	graphqlRejects?: Error;
	createCommentRejects?: Error;
	defaultBranch?: string;
	branchExists?: boolean;
	getRefRejects?: Error;
	createRefRejects?: Error;
	getContentRejects?: Error;
	createOrUpdateFileContentsRejects?: Error;
	openPrs?: ReadonlyArray<{ number: number; html_url: string }>;
	pullsCreateRejects?: Error;
	compareCommitsResult?: { merge_base_commit: { sha: string } };
	treesBySha?: Record<string, ReadonlyArray<{ path: string; sha: string; mode: string; type: "blob" | "tree" | "commit" }>>;
	createWorkflowDispatchRejects?: Error;
	workflowRuns?: ReadonlyArray<{ id: number; created_at: string }>;
	issue?: { title: string; body: string | null };
	issuesGetRejects?: Error;
}): {
	octokit: Octokit;
	merge: jest.Mock;
	update: jest.Mock;
	graphql: jest.Mock;
	createComment: jest.Mock;
	getRef: jest.Mock;
	createRef: jest.Mock;
	getContent: jest.Mock;
	createOrUpdateFileContents: jest.Mock;
	pullsList: jest.Mock;
	pullsCreate: jest.Mock;
	compareCommitsWithBasehead: jest.Mock;
	getTree: jest.Mock;
	createWorkflowDispatch: jest.Mock;
	listWorkflowRuns: jest.Mock;
	listFiles: jest.Mock;
	issuesGet: jest.Mock;
} {
	const pr = opts.pr ?? makePrResponse("<!-- declared-direction: add passwordless auth -->");
	const get = jest.fn(async (params: { mediaType?: { format: string } }) => {
		if (params.mediaType?.format === "diff") return { data: opts.diff ?? "diff --git a/x b/x" };
		return { data: pr };
	});
	const merge = opts.mergeRejects
		? jest.fn(async () => { throw opts.mergeRejects; })
		: jest.fn(async () => ({ data: {} }));
	const update = opts.updateRejects
		? jest.fn(async () => { throw opts.updateRejects; })
		: jest.fn(async () => ({ data: {} }));
	const listFiles = jest.fn(async () => ({ data: opts.files ?? [{ filename: "src/auth.ts" }] }));
	const pullsList = jest.fn(async () => ({ data: opts.openPrs ?? opts.listPrs ?? [] }));
	const listForRef = jest.fn(async () => ({ data: opts.checkRuns ?? [{ status: "completed", conclusion: "success" }] }));
	const getCombinedStatusForRef = jest.fn(async () => ({
		data: opts.combinedStatus ?? { state: "success", statuses: [] },
	}));
	const graphql = opts.graphqlRejects
		? jest.fn(async () => { throw opts.graphqlRejects; })
		: jest.fn(async () => opts.graphqlResult ?? { revertPullRequest: { pullRequest: { url: "https://github.com/org/repo/pull/8" } } });
	const createComment = opts.createCommentRejects
		? jest.fn(async () => { throw opts.createCommentRejects; })
		: jest.fn(async () => ({ data: {} }));
	const issuesGet = opts.issuesGetRejects
		? jest.fn(async () => { throw opts.issuesGetRejects; })
		: jest.fn(async () => ({ data: opts.issue ?? { title: "Add passwordless auth", body: "Users should log in via a magic link." } }));

	const reposGet = jest.fn(async () => ({ data: { default_branch: opts.defaultBranch ?? "main" } }));
	let getRefCalls = 0;
	const getRef = opts.getRefRejects
		? jest.fn(async () => { throw opts.getRefRejects; })
		: jest.fn(async () => {
			// First call checks whether the setup branch exists; only that one should
			// miss when simulating a fresh branch — the fallback call for the default
			// branch's tip (to create the setup branch from) must still resolve.
			getRefCalls += 1;
			if (opts.branchExists === false && getRefCalls === 1) throw notFoundError();
			return { data: { object: { sha: "default-sha" } } };
		});
	const createRef = opts.createRefRejects
		? jest.fn(async () => { throw opts.createRefRejects; })
		: jest.fn(async () => ({ data: {} }));
	const getContent = opts.getContentRejects
		? jest.fn(async () => { throw opts.getContentRejects; })
		: jest.fn(async () => { throw notFoundError(); });
	const createOrUpdateFileContents = opts.createOrUpdateFileContentsRejects
		? jest.fn(async () => { throw opts.createOrUpdateFileContentsRejects; })
		: jest.fn(async () => ({ data: {} }));
	const pullsCreate = opts.pullsCreateRejects
		? jest.fn(async () => { throw opts.pullsCreateRejects; })
		: jest.fn(async () => ({ data: { number: 9, html_url: "https://github.com/org/repo/pull/9" } }));
	const compareCommitsWithBasehead = jest.fn(async () => ({
		data: opts.compareCommitsResult ?? { merge_base_commit: { sha: "merge-base-sha" } },
	}));
	const getTree = jest.fn(async (params: unknown) => {
		const { tree_sha } = params as { tree_sha: string };
		return { data: { tree: opts.treesBySha?.[tree_sha] ?? [] } };
	});
	const createWorkflowDispatch = opts.createWorkflowDispatchRejects
		? jest.fn(async () => { throw opts.createWorkflowDispatchRejects; })
		: jest.fn(async () => ({ data: undefined }));
	const listWorkflowRuns = jest.fn(async () => ({ data: { workflow_runs: opts.workflowRuns ?? [] } }));

	const paginate = jest.fn(async (method: (p: unknown) => Promise<{ data: unknown }>, params: unknown) => {
		const res = await method(params);
		return res.data;
	});

	const octokit = {
		rest: {
			pulls: { get, merge, update, listFiles, list: pullsList, create: pullsCreate },
			checks: { listForRef },
			repos: { getCombinedStatusForRef, get: reposGet, getContent, createOrUpdateFileContents, compareCommitsWithBasehead },
			git: { getRef, createRef, getTree },
			issues: { createComment, get: issuesGet },
			actions: { createWorkflowDispatch, listWorkflowRuns },
		},
		paginate,
		graphql,
	} as unknown as Octokit;

	return {
		octokit,
		merge,
		update,
		graphql,
		createComment,
		getRef,
		createRef,
		getContent,
		createOrUpdateFileContents,
		pullsList,
		pullsCreate,
		compareCommitsWithBasehead,
		getTree,
		createWorkflowDispatch,
		listWorkflowRuns,
		listFiles,
		issuesGet,
	};
}

describe("extractLinkedIssueNumber", () => {
	it("matches GitHub's closing keywords case-insensitively", () => {
		expect(extractLinkedIssueNumber("Closes #12")).toBe(12);
		expect(extractLinkedIssueNumber("fixes #7")).toBe(7);
		expect(extractLinkedIssueNumber("Resolved #99")).toBe(99);
		expect(extractLinkedIssueNumber("CLOSE #3")).toBe(3);
		expect(extractLinkedIssueNumber("Fixed #4")).toBe(4);
	});

	it("ignores a bare #<n> mention that isn't preceded by a closing keyword", () => {
		expect(extractLinkedIssueNumber("See #12 for context")).toBeUndefined();
	});

	it("returns undefined for a null or keyword-free body", () => {
		expect(extractLinkedIssueNumber(null)).toBeUndefined();
		expect(extractLinkedIssueNumber("just a plain description")).toBeUndefined();
	});
});

describe("OctokitGitHubClient", () => {
	describe("getPullRequest", () => {
		it("extracts declaredDirection from the HTML-comment marker", async () => {
			const { octokit } = makeFakeOctokit({});
			const client = new OctokitGitHubClient(octokit);
			const payload = await client.getPullRequest("org", "repo", 7);
			expect(payload.declaredDirection).toBe("add passwordless auth");
			expect(payload.diff).toBe("diff --git a/x b/x");
			expect(payload.filesTouched).toEqual(["src/auth.ts"]);
		});

		it("falls back to a title/body-derived direction when the PR body has no marker (INV-1: never a real declaration)", async () => {
			const { octokit } = makeFakeOctokit({ pr: makePrResponse("just a plain description") });
			const client = new OctokitGitHubClient(octokit);
			const payload = await client.getPullRequest("org", "repo", 7);
			expect(payload.declaredDirection).toBe("add passwordless auth: just a plain description");
			expect(payload.directionInferred).toBe(true);
		});

		it("falls back to UNDECLARED_DIRECTION when the PR has no marker and no title/body to fall back to", async () => {
			const { octokit } = makeFakeOctokit({ pr: makePrResponse("   ", { title: "   " }) });
			const client = new OctokitGitHubClient(octokit);
			const payload = await client.getPullRequest("org", "repo", 7);
			expect(payload.declaredDirection).toBe(UNDECLARED_DIRECTION);
			expect(payload.directionInferred).toBe(true);
		});

		it("extracts linkedIssueNumber from a closing keyword in the PR body", async () => {
			const { octokit } = makeFakeOctokit({
				pr: makePrResponse("<!-- declared-direction: add passwordless auth -->\n\nCloses #12"),
			});
			const client = new OctokitGitHubClient(octokit);
			const payload = await client.getPullRequest("org", "repo", 7);
			expect(payload.linkedIssueNumber).toBe(12);
		});

		it("leaves linkedIssueNumber undefined when the body has no closing keyword", async () => {
			const { octokit } = makeFakeOctokit({});
			const client = new OctokitGitHubClient(octokit);
			const payload = await client.getPullRequest("org", "repo", 7);
			expect(payload.linkedIssueNumber).toBeUndefined();
		});

		it("maps labels (string or object form) and assignees", async () => {
			const { octokit } = makeFakeOctokit({
				pr: makePrResponse(null, {
					labels: ["bug", { name: "security" }, { name: undefined }],
					assignees: [{ login: "octocat" }, { login: "hubot" }],
				}),
			});
			const client = new OctokitGitHubClient(octokit);
			const payload = await client.getPullRequest("org", "repo", 7);
			expect(payload.labels).toEqual(["bug", "security"]);
			expect(payload.assignees).toEqual(["octocat", "hubot"]);
		});

		it("defaults assignees to an empty array when GitHub reports it as null", async () => {
			const { octokit } = makeFakeOctokit({ pr: makePrResponse(null, { assignees: null }) });
			const client = new OctokitGitHubClient(octokit);
			const payload = await client.getPullRequest("org", "repo", 7);
			expect(payload.assignees).toEqual([]);
		});

		it("reports pending when a check run has not completed", async () => {
			const { octokit } = makeFakeOctokit({ checkRuns: [{ status: "in_progress", conclusion: null }] });
			const client = new OctokitGitHubClient(octokit);
			const payload = await client.getPullRequest("org", "repo", 7);
			expect(payload.ciStatus).toBe("pending");
		});

		it("reports failure when a check run concluded failure", async () => {
			const { octokit } = makeFakeOctokit({
				checkRuns: [
					{ status: "completed", conclusion: "success" },
					{ status: "completed", conclusion: "failure" },
				],
			});
			const client = new OctokitGitHubClient(octokit);
			const payload = await client.getPullRequest("org", "repo", 7);
			expect(payload.ciStatus).toBe("failure");
		});

		it("reports unknown when there are no check runs", async () => {
			const { octokit } = makeFakeOctokit({ checkRuns: [] });
			const client = new OctokitGitHubClient(octokit);
			const payload = await client.getPullRequest("org", "repo", 7);
			expect(payload.ciStatus).toBe("unknown");
		});

		it("reports failure when a check run has gone stale", async () => {
			const { octokit } = makeFakeOctokit({ checkRuns: [{ status: "completed", conclusion: "stale" }] });
			const client = new OctokitGitHubClient(octokit);
			const payload = await client.getPullRequest("org", "repo", 7);
			expect(payload.ciStatus).toBe("failure");
		});

		it("falls back to the legacy commit status API when there are no check runs", async () => {
			const { octokit } = makeFakeOctokit({
				checkRuns: [],
				combinedStatus: { state: "failure", statuses: [{ state: "failure" }] },
			});
			const client = new OctokitGitHubClient(octokit);
			const payload = await client.getPullRequest("org", "repo", 7);
			expect(payload.ciStatus).toBe("failure");
		});

		it("reports pending from a legacy commit status with no check runs", async () => {
			const { octokit } = makeFakeOctokit({
				checkRuns: [],
				combinedStatus: { state: "pending", statuses: [{ state: "pending" }] },
			});
			const client = new OctokitGitHubClient(octokit);
			const payload = await client.getPullRequest("org", "repo", 7);
			expect(payload.ciStatus).toBe("pending");
		});

		it("summarizes completed/total check runs while some are still running", async () => {
			const { octokit } = makeFakeOctokit({
				checkRuns: [
					{ status: "completed", conclusion: "success" },
					{ status: "in_progress", conclusion: null },
					{ status: "queued", conclusion: null },
				],
			});
			const client = new OctokitGitHubClient(octokit);
			const payload = await client.getPullRequest("org", "repo", 7);
			expect(payload.ciStatus).toBe("pending");
			expect(payload.ciChecksSummary).toEqual({ completed: 1, total: 3 });
		});

		it("summarizes check runs as all-complete once every run has finished", async () => {
			const { octokit } = makeFakeOctokit({
				checkRuns: [
					{ status: "completed", conclusion: "success" },
					{ status: "completed", conclusion: "success" },
				],
			});
			const client = new OctokitGitHubClient(octokit);
			const payload = await client.getPullRequest("org", "repo", 7);
			expect(payload.ciStatus).toBe("success");
			expect(payload.ciChecksSummary).toEqual({ completed: 2, total: 2 });
		});

		it("omits ciChecksSummary when only the legacy commit status API has data", async () => {
			const { octokit } = makeFakeOctokit({
				checkRuns: [],
				combinedStatus: { state: "pending", statuses: [{ state: "pending" }] },
			});
			const client = new OctokitGitHubClient(octokit);
			const payload = await client.getPullRequest("org", "repo", 7);
			expect(payload.ciChecksSummary).toBeUndefined();
		});
	});

	describe("listOpenPullRequests", () => {
		it("maps every PR returned by the list endpoint", async () => {
			const prA = makePrResponse("<!-- declared-direction: add passwordless auth -->", { id: 1, number: 5 });
			const prB = makePrResponse("<!-- declared-direction: add rate limiting -->", { id: 2, number: 6 });
			const { octokit } = makeFakeOctokit({ listPrs: [prA, prB] });
			const client = new OctokitGitHubClient(octokit);
			const { payloads, skipped } = await client.listOpenPullRequests("org", "repo");
			expect(payloads.map((p) => p.number)).toEqual([5, 6]);
			expect(payloads.map((p) => p.declaredDirection)).toEqual([
				"add passwordless auth",
				"add rate limiting",
			]);
			expect(skipped).toEqual([]);
		});

		it("ingests a PR with no declared-direction marker instead of skipping it", async () => {
			const good = makePrResponse("<!-- declared-direction: add passwordless auth -->", { id: 1, number: 5 });
			const undeclared = makePrResponse("no marker here", { id: 2, number: 6 });
			const { octokit } = makeFakeOctokit({ listPrs: [good, undeclared] });
			const client = new OctokitGitHubClient(octokit);
			const { payloads, skipped } = await client.listOpenPullRequests("org", "repo");
			expect(payloads.map((p) => p.number)).toEqual([5, 6]);
			expect(payloads.map((p) => p.declaredDirection)).toEqual([
				"add passwordless auth",
				"add passwordless auth: no marker here",
			]);
			expect(payloads.map((p) => p.directionInferred)).toEqual([false, true]);
			expect(skipped).toEqual([]);
		});

		it("skips a PR that fails to map instead of failing the whole batch, and reports it as skipped", async () => {
			const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
			const good = makePrResponse("<!-- declared-direction: add passwordless auth -->", { id: 1, number: 5 });
			const bad = makePrResponse("<!-- declared-direction: add rate limiting -->", { id: 2, number: 6 });
			const { octokit, listFiles } = makeFakeOctokit({ listPrs: [good, bad] });
			listFiles.mockImplementation(async (params: unknown) => {
				if ((params as { pull_number: number }).pull_number === 6) {
					throw new Error("GitHub API error fetching files");
				}
				return { data: [{ filename: "src/auth.ts" }] };
			});
			const client = new OctokitGitHubClient(octokit);
			const { payloads, skipped } = await client.listOpenPullRequests("org", "repo");
			expect(payloads.map((p) => p.number)).toEqual([5]);
			expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("org/repo#6"));
			expect(skipped).toEqual([
				{ number: 6, reason: expect.stringContaining("GitHub API error fetching files") },
			]);
			errorSpy.mockRestore();
		});

		it("processes more PRs than the internal concurrency cap, preserving order", async () => {
			const prs = Array.from({ length: 8 }, (_, i) =>
				makePrResponse("<!-- declared-direction: add passwordless auth -->", { id: i + 1, number: i + 1 }),
			);
			const { octokit } = makeFakeOctokit({ listPrs: prs });
			const client = new OctokitGitHubClient(octokit);
			const { payloads } = await client.listOpenPullRequests("org", "repo");
			expect(payloads.map((p) => p.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
		});
	});

	describe("mergePullRequest", () => {
		it("calls pulls.merge with the right pull number", async () => {
			const { octokit, merge } = makeFakeOctokit({});
			const client = new OctokitGitHubClient(octokit);
			await client.mergePullRequest("org", "repo", 7);
			expect(merge).toHaveBeenCalledWith({ owner: "org", repo: "repo", pull_number: 7 });
		});

		it("does not mark the PR ready for review when it isn't a draft", async () => {
			const { octokit, graphql } = makeFakeOctokit({});
			const client = new OctokitGitHubClient(octokit);
			await client.mergePullRequest("org", "repo", 7);
			expect(graphql).not.toHaveBeenCalled();
		});

		it("marks a draft PR ready for review before merging", async () => {
			const { octokit, graphql, merge } = makeFakeOctokit({ pr: makePrResponse(null, { draft: true }) });
			const client = new OctokitGitHubClient(octokit);
			await client.mergePullRequest("org", "repo", 7);
			expect(graphql).toHaveBeenCalledWith(expect.stringContaining("markPullRequestReadyForReview"), {
				pullRequestId: "PR_node123",
			});
			expect(merge).toHaveBeenCalledWith({ owner: "org", repo: "repo", pull_number: 7 });
		});

		it("raises an actionable error when the App lacks write permission to merge", async () => {
			const { octokit } = makeFakeOctokit({ mergeRejects: insufficientPermissionError() });
			const client = new OctokitGitHubClient(octokit);
			await expect(client.mergePullRequest("org", "repo", 7)).rejects.toThrow(InsufficientGitHubPermissionError);
			await expect(client.mergePullRequest("org", "repo", 7)).rejects.toThrow(/README.md/);
		});

		it("rethrows an unrelated merge failure unchanged", async () => {
			const notFound = new FakeHttpError("Not Found", 404);
			const { octokit } = makeFakeOctokit({ mergeRejects: notFound });
			const client = new OctokitGitHubClient(octokit);
			await expect(client.mergePullRequest("org", "repo", 7)).rejects.toBe(notFound);
		});
	});

	describe("closePullRequest", () => {
		it("updates the PR state to closed", async () => {
			const { octokit, update } = makeFakeOctokit({});
			const client = new OctokitGitHubClient(octokit);
			await client.closePullRequest("org", "repo", 7);
			expect(update).toHaveBeenCalledWith({ owner: "org", repo: "repo", pull_number: 7, state: "closed" });
		});

		it("raises an actionable error when the App lacks write permission to close", async () => {
			const { octokit } = makeFakeOctokit({ updateRejects: insufficientPermissionError() });
			const client = new OctokitGitHubClient(octokit);
			await expect(client.closePullRequest("org", "repo", 7)).rejects.toThrow(InsufficientGitHubPermissionError);
		});
	});

	describe("revertPullRequest", () => {
		it("resolves the PR's node id and returns the new revert PR's url", async () => {
			const { octokit, graphql } = makeFakeOctokit({});
			const client = new OctokitGitHubClient(octokit);
			const url = await client.revertPullRequest("org", "repo", 7);
			expect(url).toBe("https://github.com/org/repo/pull/8");
			expect(graphql).toHaveBeenCalledWith(expect.stringContaining("revertPullRequest"), {
				pullRequestId: "PR_node123",
			});
		});

		it("raises an actionable error when the App lacks write permission to revert", async () => {
			const { octokit } = makeFakeOctokit({ graphqlRejects: insufficientPermissionError() });
			const client = new OctokitGitHubClient(octokit);
			await expect(client.revertPullRequest("org", "repo", 7)).rejects.toThrow(InsufficientGitHubPermissionError);
		});
	});

	describe("postReviewCardComment", () => {
		it("posts a formatted comment via the issues API", async () => {
			const { octokit, createComment } = makeFakeOctokit({});
			const client = new OctokitGitHubClient(octokit);

			await client.postReviewCardComment("org", "repo", 7, "accept", {
				bundleId: "b-1",
				directionSummary: "add passwordless auth",
				directionInferred: false,
				repoOwner: "org",
				repoName: "repo",
				blastRadius: 2,
				flags: [],
				drift: { status: "clean" },
				residualDisclosure: "behavioral confirm not run",
				specConformance: { status: "clean" },
				specConformanceDisclosure: "",
				inputsHash: "hash-1",
				memberCount: 0,
				requiresAcceptConfirmation: false,
			});

			expect(createComment).toHaveBeenCalledWith(
				expect.objectContaining({
					owner: "org",
					repo: "repo",
					issue_number: 7,
					body: expect.stringContaining("add passwordless auth"),
				}),
			);
		});

		it("raises an actionable error when the App lacks write permission to comment", async () => {
			const { octokit } = makeFakeOctokit({ createCommentRejects: insufficientPermissionError() });
			const client = new OctokitGitHubClient(octokit);
			await expect(
				client.postReviewCardComment("org", "repo", 7, "accept", {
					bundleId: "b-1",
					directionSummary: "add passwordless auth",
					directionInferred: false,
					repoOwner: "org",
					repoName: "repo",
					blastRadius: 2,
					flags: [],
					drift: { status: "clean" },
					residualDisclosure: "behavioral confirm not run",
					specConformance: { status: "clean" },
					specConformanceDisclosure: "",
					inputsHash: "hash-1",
					memberCount: 0,
					requiresAcceptConfirmation: false,
				}),
			).rejects.toThrow(InsufficientGitHubPermissionError);
		});
	});

	describe("getIssue", () => {
		it("returns the issue's title and body", async () => {
			const { octokit } = makeFakeOctokit({ issue: { title: "Add passwordless auth", body: "Magic link login." } });
			const client = new OctokitGitHubClient(octokit);
			const issue = await client.getIssue("org", "repo", 12);
			expect(issue).toEqual({ title: "Add passwordless auth", body: "Magic link login." });
		});

		it("returns undefined on a 404 (deleted or inaccessible issue)", async () => {
			const { octokit } = makeFakeOctokit({ issuesGetRejects: notFoundError() });
			const client = new OctokitGitHubClient(octokit);
			const issue = await client.getIssue("org", "repo", 12);
			expect(issue).toBeUndefined();
		});

		it("rethrows non-404 errors", async () => {
			const { octokit } = makeFakeOctokit({ issuesGetRejects: new Error("network error") });
			const client = new OctokitGitHubClient(octokit);
			await expect(client.getIssue("org", "repo", 12)).rejects.toThrow("network error");
		});
	});

	describe("commitFileToBranch", () => {
		it("creates the branch from the default branch's tip when it doesn't exist yet", async () => {
			const { octokit, getRef, createRef, createOrUpdateFileContents } = makeFakeOctokit({ branchExists: false });
			const client = new OctokitGitHubClient(octokit);
			await client.commitFileToBranch("org", "repo", "quire/setup", "README.md", "hello", "add readme");

			expect(getRef).toHaveBeenCalledWith({ owner: "org", repo: "repo", ref: "heads/quire/setup" });
			expect(getRef).toHaveBeenCalledWith({ owner: "org", repo: "repo", ref: "heads/main" });
			expect(createRef).toHaveBeenCalledWith({ owner: "org", repo: "repo", ref: "refs/heads/quire/setup", sha: "default-sha" });
			expect(createOrUpdateFileContents).toHaveBeenCalledWith(
				expect.objectContaining({
					owner: "org",
					repo: "repo",
					path: "README.md",
					content: Buffer.from("hello", "utf8").toString("base64"),
					branch: "quire/setup",
				}),
			);
		});

		it("reuses an existing branch without creating a new one", async () => {
			const { octokit, createRef, createOrUpdateFileContents } = makeFakeOctokit({ branchExists: true });
			const client = new OctokitGitHubClient(octokit);
			await client.commitFileToBranch("org", "repo", "quire/setup", "README.md", "hello", "add readme");

			expect(createRef).not.toHaveBeenCalled();
			expect(createOrUpdateFileContents).toHaveBeenCalled();
		});

		it("raises an actionable error when the App lacks write permission to commit a file", async () => {
			const { octokit } = makeFakeOctokit({
				branchExists: true,
				createOrUpdateFileContentsRejects: insufficientPermissionError(),
			});
			const client = new OctokitGitHubClient(octokit);
			await expect(
				client.commitFileToBranch("org", "repo", "quire/setup", "README.md", "hello", "add readme"),
			).rejects.toThrow(InsufficientGitHubPermissionError);
		});
	});

	describe("getMergeability", () => {
		it("reads the base branch's live tip instead of the PR's cached (and possibly stale) base.sha", async () => {
			const { octokit, getRef } = makeFakeOctokit({
				pr: makePrResponse("<!-- declared-direction: x -->", {
					base: { ref: "main", sha: "stale-base-sha", repo: { id: 1 } },
					head: { sha: "head-sha", ref: "feature", repo: { id: 1 } },
					mergeable_state: "dirty",
				}),
			});
			const client = new OctokitGitHubClient(octokit);
			const result = await client.getMergeability("org", "repo", 7);

			expect(getRef).toHaveBeenCalledWith({ owner: "org", repo: "repo", ref: "heads/main" });
			expect(result.baseSha).toBe("default-sha");
			expect(result.baseSha).not.toBe("stale-base-sha");
		});
	});

	describe("getConflictTrees", () => {
		it("diffs against the base branch's live tip, not the PR's cached base.sha", async () => {
			const { octokit, getRef, compareCommitsWithBasehead, getTree } = makeFakeOctokit({
				pr: makePrResponse("<!-- declared-direction: x -->", {
					base: { ref: "main", sha: "stale-base-sha", repo: { id: 1 } },
					head: { sha: "head-sha", ref: "feature", repo: { id: 1 } },
				}),
				compareCommitsResult: { merge_base_commit: { sha: "merge-base-sha" } },
			});
			const client = new OctokitGitHubClient(octokit);
			const result = await client.getConflictTrees("org", "repo", 7);

			expect(getRef).toHaveBeenCalledWith({ owner: "org", repo: "repo", ref: "heads/main" });
			expect(compareCommitsWithBasehead).toHaveBeenCalledWith(
				expect.objectContaining({ basehead: "default-sha...head-sha" }),
			);
			expect(getTree).toHaveBeenCalledWith(expect.objectContaining({ tree_sha: "default-sha" }));
			expect(result.baseSha).toBe("default-sha");
			expect(result.baseSha).not.toBe("stale-base-sha");
		});
	});

	describe("findOrCreatePullRequest", () => {
		it("returns the existing open PR without creating a new one", async () => {
			const { octokit, pullsCreate } = makeFakeOctokit({
				openPrs: [{ number: 4, html_url: "https://github.com/org/repo/pull/4" }],
			});
			const client = new OctokitGitHubClient(octokit);
			const result = await client.findOrCreatePullRequest("org", "repo", {
				head: "quire/setup",
				base: "main",
				title: "Set up Quire",
				body: "body",
			});

			expect(result).toEqual({ number: 4, url: "https://github.com/org/repo/pull/4", created: false });
			expect(pullsCreate).not.toHaveBeenCalled();
		});

		it("creates a new PR when none is open", async () => {
			const { octokit } = makeFakeOctokit({ openPrs: [] });
			const client = new OctokitGitHubClient(octokit);
			const result = await client.findOrCreatePullRequest("org", "repo", {
				head: "quire/setup",
				base: "main",
				title: "Set up Quire",
				body: "body",
			});

			expect(result).toEqual({ number: 9, url: "https://github.com/org/repo/pull/9", created: true });
		});

		it("raises an actionable error when the App lacks write permission to open a pull request", async () => {
			const { octokit } = makeFakeOctokit({ openPrs: [], pullsCreateRejects: insufficientPermissionError() });
			const client = new OctokitGitHubClient(octokit);
			await expect(
				client.findOrCreatePullRequest("org", "repo", {
					head: "quire/setup",
					base: "main",
					title: "Set up Quire",
					body: "body",
				}),
			).rejects.toThrow(InsufficientGitHubPermissionError);
		});
	});
});
