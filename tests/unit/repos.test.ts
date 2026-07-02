import { describe, it, expect, jest } from "@jest/globals";
import type { Octokit } from "@octokit/rest";
import { listInstallationRepositories } from "../../src/engine/github/repos.js";

function makeFakeOctokit(repos: ReadonlyArray<Record<string, unknown>>): Octokit {
	const listReposAccessibleToInstallation = jest.fn();
	const paginate = jest.fn(async () => repos);
	return {
		rest: { apps: { listReposAccessibleToInstallation } },
		paginate,
	} as unknown as Octokit;
}

describe("listInstallationRepositories", () => {
	it("maps the paginated installation-repositories response into RepoSummary objects", async () => {
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

		const repos = await listInstallationRepositories(octokit);

		expect(repos).toEqual([
			{ owner: "octocat", name: "hello-world", fullName: "octocat/hello-world", private: false, defaultBranch: "main" },
			{ owner: "octocat", name: "secret-project", fullName: "octocat/secret-project", private: true, defaultBranch: "trunk" },
		]);
	});

	it("returns an empty list when the installation has no accessible repos", async () => {
		const octokit = makeFakeOctokit([]);

		const repos = await listInstallationRepositories(octokit);

		expect(repos).toEqual([]);
	});
});
