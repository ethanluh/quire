import { describe, it, expect, jest } from "@jest/globals";
import type { Octokit } from "@octokit/rest";
import { listRepositories } from "../../src/engine/github/repos.js";

function makeFakeOctokit(repos: ReadonlyArray<Record<string, unknown>>): Octokit {
	const listForAuthenticatedUser = jest.fn();
	const paginate = jest.fn(async () => repos);
	return {
		rest: { repos: { listForAuthenticatedUser } },
		paginate,
	} as unknown as Octokit;
}

describe("listRepositories", () => {
	it("maps the paginated GitHub response into RepoSummary objects", async () => {
		const octokit = makeFakeOctokit([
			{
				owner: { login: "octocat" },
				name: "hello-world",
				full_name: "octocat/hello-world",
				private: false,
				default_branch: "main",
			},
			{
				owner: { login: "octocat" },
				name: "secret-project",
				full_name: "octocat/secret-project",
				private: true,
				default_branch: "trunk",
			},
		]);

		const repos = await listRepositories(octokit);

		expect(repos).toEqual([
			{ owner: "octocat", name: "hello-world", fullName: "octocat/hello-world", private: false, defaultBranch: "main" },
			{ owner: "octocat", name: "secret-project", fullName: "octocat/secret-project", private: true, defaultBranch: "trunk" },
		]);
	});

	it("returns an empty list when the authenticated user has no repos", async () => {
		const octokit = makeFakeOctokit([]);

		const repos = await listRepositories(octokit);

		expect(repos).toEqual([]);
	});
});
