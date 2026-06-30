import { describe, it, expect, jest } from "@jest/globals";
import type { Octokit } from "@octokit/rest";
import { OctokitGitHubClient } from "../../src/github/octokitClient.js";

interface FakeCheckRun {
	status: "completed" | "in_progress" | "queued";
	conclusion: string | null;
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
	diff?: string;
	files?: ReadonlyArray<{ filename: string }>;
	checkRuns?: ReadonlyArray<FakeCheckRun>;
	graphqlResult?: unknown;
}): { octokit: Octokit; merge: jest.Mock; graphql: jest.Mock } {
	const pr = opts.pr ?? makePrResponse("<!-- declared-direction: add passwordless auth -->");
	const get = jest.fn(async (params: { mediaType?: { format: string } }) => {
		if (params.mediaType?.format === "diff") return { data: opts.diff ?? "diff --git a/x b/x" };
		return { data: pr };
	});
	const merge = jest.fn(async () => ({ data: {} }));
	const listFiles = jest.fn(async () => ({ data: opts.files ?? [{ filename: "src/auth.ts" }] }));
	const list = jest.fn(async () => ({ data: [pr] }));
	const listForRef = jest.fn(async () => ({ data: opts.checkRuns ?? [{ status: "completed", conclusion: "success" }] }));
	const graphql = jest.fn(async () => opts.graphqlResult ?? { revertPullRequest: { pullRequest: { url: "https://github.com/org/repo/pull/8" } } });

	const paginate = jest.fn(async (method: (p: unknown) => Promise<{ data: unknown }>, params: unknown) => {
		const res = await method(params);
		return res.data;
	});

	const octokit = {
		rest: { pulls: { get, merge, listFiles, list }, checks: { listForRef } },
		paginate,
		graphql,
	} as unknown as Octokit;

	return { octokit, merge, graphql };
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
	});

	describe("mergePullRequest", () => {
		it("calls pulls.merge with the right pull number", async () => {
			const { octokit, merge } = makeFakeOctokit({});
			const client = new OctokitGitHubClient(octokit);
			await client.mergePullRequest("org", "repo", 7);
			expect(merge).toHaveBeenCalledWith({ owner: "org", repo: "repo", pull_number: 7 });
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
	});
});
