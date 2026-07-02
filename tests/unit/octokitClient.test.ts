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
}): { octokit: Octokit; merge: jest.Mock; update: jest.Mock; graphql: jest.Mock; createComment: jest.Mock } {
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
	const list = jest.fn(async () => ({ data: opts.listPrs ?? [pr] }));
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

	const paginate = jest.fn(async (method: (p: unknown) => Promise<{ data: unknown }>, params: unknown) => {
		const res = await method(params);
		return res.data;
	});

	const octokit = {
		rest: {
			pulls: { get, merge, update, listFiles, list },
			checks: { listForRef },
			repos: { getCombinedStatusForRef },
			issues: { createComment },
		},
		paginate,
		graphql,
	} as unknown as Octokit;

	return { octokit, merge, update, graphql, createComment };
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
				}),
			).rejects.toThrow(InsufficientGitHubPermissionError);
		});
	});
});
