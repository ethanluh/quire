import { describe, it, expect, jest } from "@jest/globals";
import type { Octokit } from "@octokit/rest";
import { listRepositories } from "../../src/engine/github/repos.js";

function makeFakeOctokit(
	repos: ReadonlyArray<Record<string, unknown>>,
	options: {
		starred?: ReadonlyArray<Record<string, unknown>>;
		pinned?: ReadonlyArray<string>;
		starredThrows?: boolean;
		pinnedThrows?: boolean;
	} = {},
): Octokit {
	const listForAuthenticatedUser = jest.fn();
	const listReposStarredByAuthenticatedUser = jest.fn();
	const paginate = jest.fn(async (fn: unknown) => {
		if (fn === listReposStarredByAuthenticatedUser) {
			if (options.starredThrows) throw new Error("starred fetch failed");
			return options.starred ?? [];
		}
		return repos;
	});
	const graphql = jest.fn(async () => {
		if (options.pinnedThrows) throw new Error("pinned fetch failed");
		return {
			viewer: {
				pinnedItems: {
					nodes: (options.pinned ?? []).map((nameWithOwner) => ({ nameWithOwner })),
				},
			},
		};
	});
	return {
		rest: {
			repos: { listForAuthenticatedUser },
			activity: { listReposStarredByAuthenticatedUser },
		},
		paginate,
		graphql,
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
				archived: false,
			},
			{
				owner: { login: "octocat" },
				name: "secret-project",
				full_name: "octocat/secret-project",
				private: true,
				default_branch: "trunk",
				archived: false,
			},
		]);

		const repos = await listRepositories(octokit);

		expect(repos).toEqual([
			{
				owner: "octocat",
				name: "hello-world",
				fullName: "octocat/hello-world",
				private: false,
				defaultBranch: "main",
				starred: false,
				pinned: false,
			},
			{
				owner: "octocat",
				name: "secret-project",
				fullName: "octocat/secret-project",
				private: true,
				defaultBranch: "trunk",
				starred: false,
				pinned: false,
			},
		]);
	});

	it("returns an empty list when the authenticated user has no repos", async () => {
		const octokit = makeFakeOctokit([]);

		const repos = await listRepositories(octokit);

		expect(repos).toEqual([]);
	});

	it("excludes archived repos", async () => {
		const octokit = makeFakeOctokit([
			{
				owner: { login: "octocat" },
				name: "live-project",
				full_name: "octocat/live-project",
				private: false,
				default_branch: "main",
				archived: false,
			},
			{
				owner: { login: "octocat" },
				name: "dead-project",
				full_name: "octocat/dead-project",
				private: false,
				default_branch: "main",
				archived: true,
			},
		]);

		const repos = await listRepositories(octokit);

		expect(repos.map((r) => r.name)).toEqual(["live-project"]);
	});

	it("sorts starred repos before pinned repos, and pinned before the rest, preserving update order within each tier", async () => {
		const octokit = makeFakeOctokit(
			[
				{ owner: { login: "octocat" }, name: "plain-a", full_name: "octocat/plain-a", private: false, default_branch: "main", archived: false },
				{ owner: { login: "octocat" }, name: "starred-a", full_name: "octocat/starred-a", private: false, default_branch: "main", archived: false },
				{ owner: { login: "octocat" }, name: "pinned-a", full_name: "octocat/pinned-a", private: false, default_branch: "main", archived: false },
				{ owner: { login: "octocat" }, name: "plain-b", full_name: "octocat/plain-b", private: false, default_branch: "main", archived: false },
				{ owner: { login: "octocat" }, name: "starred-b", full_name: "octocat/starred-b", private: false, default_branch: "main", archived: false },
			],
			{
				starred: [{ full_name: "octocat/starred-a" }, { full_name: "octocat/starred-b" }],
				pinned: ["octocat/pinned-a"],
			},
		);

		const repos = await listRepositories(octokit);

		expect(repos.map((r) => r.name)).toEqual(["starred-a", "starred-b", "pinned-a", "plain-a", "plain-b"]);
		expect(repos.find((r) => r.name === "starred-a")).toMatchObject({ starred: true, pinned: false });
		expect(repos.find((r) => r.name === "pinned-a")).toMatchObject({ starred: false, pinned: true });
	});

	it("treats a starred-and-pinned repo as favorite tier, not double-counted", async () => {
		const octokit = makeFakeOctokit(
			[{ owner: { login: "octocat" }, name: "both", full_name: "octocat/both", private: false, default_branch: "main", archived: false }],
			{ starred: [{ full_name: "octocat/both" }], pinned: ["octocat/both"] },
		);

		const repos = await listRepositories(octokit);

		expect(repos).toEqual([
			{
				owner: "octocat",
				name: "both",
				fullName: "octocat/both",
				private: false,
				defaultBranch: "main",
				starred: true,
				pinned: true,
			},
		]);
	});

	it("falls back to an unprioritized list if the starred or pinned lookup fails", async () => {
		const octokit = makeFakeOctokit(
			[{ owner: { login: "octocat" }, name: "hello-world", full_name: "octocat/hello-world", private: false, default_branch: "main", archived: false }],
			{ starredThrows: true, pinnedThrows: true },
		);

		const repos = await listRepositories(octokit);

		expect(repos).toEqual([
			{
				owner: "octocat",
				name: "hello-world",
				fullName: "octocat/hello-world",
				private: false,
				defaultBranch: "main",
				starred: false,
				pinned: false,
			},
		]);
	});
});
