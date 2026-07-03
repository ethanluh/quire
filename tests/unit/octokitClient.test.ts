import { describe, it, expect, jest } from "@jest/globals";
import type { Octokit } from "@octokit/rest";
import { RequestError } from "@octokit/request-error";
import { OctokitGitHubClient, InsufficientGitHubPermissionError } from "../../src/engine/github/octokitClient.js";

function insufficientPermissionError(): RequestError {
	return new RequestError("Resource not accessible by integration", 403, {
		request: { method: "POST", url: "", headers: {} },
	});
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
		...overrides,
	};
}

function notFoundError(): RequestError {
	return new RequestError("Not Found", 404, { request: { method: "GET", url: "", headers: {} } });
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
			issues: { createComment },
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
	};
}

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

		it("throws when the PR body has no declared-direction marker (INV-1 fail-closed)", async () => {
			const { octokit } = makeFakeOctokit({ pr: makePrResponse("just a plain description") });
			const client = new OctokitGitHubClient(octokit);
			await expect(client.getPullRequest("org", "repo", 7)).rejects.toThrow(/declared-direction/);
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

		it("skips a PR that fails to map instead of failing the whole batch, and reports it as skipped", async () => {
			const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
			const good = makePrResponse("<!-- declared-direction: add passwordless auth -->", { id: 1, number: 5 });
			const bad = makePrResponse("no marker here", { id: 2, number: 6 });
			const { octokit } = makeFakeOctokit({ listPrs: [good, bad] });
			const client = new OctokitGitHubClient(octokit);
			const { payloads, skipped } = await client.listOpenPullRequests("org", "repo");
			expect(payloads.map((p) => p.number)).toEqual([5]);
			expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("org/repo#6"));
			expect(skipped).toEqual([
				{ number: 6, reason: expect.stringContaining("no <!-- declared-direction: ... --> marker") },
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
			const notFound = new RequestError("Not Found", 404, { request: { method: "PUT", url: "", headers: {} } });
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
				blastRadius: 2,
				flags: [],
				drift: { status: "clean" },
				residualDisclosure: "behavioral confirm not run",
				inputsHash: "hash-1",
				memberCount: 0,
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
					blastRadius: 2,
					flags: [],
					drift: { status: "clean" },
					residualDisclosure: "behavioral confirm not run",
					inputsHash: "hash-1",
					memberCount: 0,
				}),
			).rejects.toThrow(InsufficientGitHubPermissionError);
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

	describe("dispatchConflictResolution", () => {
		it("dispatches against the base branch, not the PR's head branch", async () => {
			const { octokit, createWorkflowDispatch, listWorkflowRuns } = makeFakeOctokit({
				workflowRuns: [{ id: 555, created_at: new Date(0).toISOString() }],
			});
			const client = new OctokitGitHubClient(octokit);
			await client.dispatchConflictResolution("org", "repo", {
				prNumber: 62,
				headBranch: "claude/audit-overturn-tracking",
				baseBranch: "main",
				declaredDirection: "add overturn tracking",
				callbackUrl: "https://quire.example/callbacks/action-resolution/bundle-1/resolution",
				callbackToken: "token123",
			});

			// The head branch predates Quire's setup PR for plenty of real PRs, so its own
			// copy of the workflow file may not declare workflow_dispatch at all — GitHub
			// 422s in that case. The base branch is where the setup PR actually committed it.
			expect(createWorkflowDispatch).toHaveBeenCalledWith(
				expect.objectContaining({ ref: "main", inputs: expect.objectContaining({ head_branch: "claude/audit-overturn-tracking" }) }),
			);
			expect(listWorkflowRuns).toHaveBeenCalledWith(expect.objectContaining({ branch: "main" }));
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
