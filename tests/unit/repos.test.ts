import { describe, it, expect, jest } from "@jest/globals";
import type { Octokit } from "@octokit/rest";
import { listInstallationRepositories, enrichWithStarredAndPinned } from "../../src/engine/github/repos.js";
import type { RepoSummary } from "../../src/engine/github/repos.js";

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
			{ owner: "octocat", name: "hello-world", fullName: "octocat/hello-world", private: false, defaultBranch: "main", starred: false, pinned: false },
			{ owner: "octocat", name: "secret-project", fullName: "octocat/secret-project", private: true, defaultBranch: "trunk", starred: false, pinned: false },
		]);
	});

	it("returns an empty list when the installation has no accessible repos", async () => {
		const octokit = makeFakeOctokit([]);

		const repos = await listInstallationRepositories(octokit);

		expect(repos).toEqual([]);
	});

	it("excludes archived repos", async () => {
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
				name: "dead-project",
				full_name: "octocat/dead-project",
				private: false,
				default_branch: "main",
				archived: true,
			},
		]);

		const repos = await listInstallationRepositories(octokit);

		expect(repos).toEqual([
			{ owner: "octocat", name: "hello-world", fullName: "octocat/hello-world", private: false, defaultBranch: "main", starred: false, pinned: false },
		]);
	});
});

function repo(overrides: Partial<RepoSummary> & { fullName: string }): RepoSummary {
	return {
		owner: overrides.fullName.split("/")[0] ?? "",
		name: overrides.fullName.split("/")[1] ?? "",
		private: false,
		defaultBranch: "main",
		starred: false,
		pinned: false,
		...overrides,
	};
}

function makeFakeUserOctokit(
	starred: ReadonlyArray<string>,
	pinned: ReadonlyArray<string>,
	opts?: { starredFails?: boolean; pinnedFails?: boolean },
): Octokit {
	const listReposStarredByAuthenticatedUser = jest.fn();
	const paginate = jest.fn(async () => {
		if (opts?.starredFails === true) throw new Error("boom");
		return starred.map((fullName) => ({ full_name: fullName }));
	});
	const graphql = jest.fn(async () => {
		if (opts?.pinnedFails === true) throw new Error("boom");
		return { viewer: { pinnedItems: { nodes: pinned.map((nameWithOwner) => ({ nameWithOwner })) } } };
	});
	return {
		rest: { activity: { listReposStarredByAuthenticatedUser } },
		paginate,
		graphql,
	} as unknown as Octokit;
}

describe("enrichWithStarredAndPinned", () => {
	it("sorts starred first, pinned next, preserving order within each tier", async () => {
		const repos = [repo({ fullName: "acme/a" }), repo({ fullName: "acme/b" }), repo({ fullName: "acme/c" }), repo({ fullName: "acme/d" })];
		const octokit = makeFakeUserOctokit(["acme/c"], ["acme/b", "acme/d"]);

		const result = await enrichWithStarredAndPinned(repos, octokit);

		expect(result.map((r) => r.fullName)).toEqual(["acme/c", "acme/b", "acme/d", "acme/a"]);
		expect(result.find((r) => r.fullName === "acme/c")).toEqual(expect.objectContaining({ starred: true, pinned: false }));
		expect(result.find((r) => r.fullName === "acme/b")).toEqual(expect.objectContaining({ starred: false, pinned: true }));
	});

	it("degrades to an unsorted, unstarred/unpinned list when the starred lookup fails", async () => {
		const repos = [repo({ fullName: "acme/a" }), repo({ fullName: "acme/b" })];
		const octokit = makeFakeUserOctokit([], [], { starredFails: true });

		const result = await enrichWithStarredAndPinned(repos, octokit);

		expect(result.map((r) => r.fullName)).toEqual(["acme/a", "acme/b"]);
		expect(result.every((r) => !r.starred)).toBe(true);
	});

	it("degrades to an unsorted, unstarred/unpinned list when the pinned lookup fails", async () => {
		const repos = [repo({ fullName: "acme/a" }), repo({ fullName: "acme/b" })];
		const octokit = makeFakeUserOctokit([], [], { pinnedFails: true });

		const result = await enrichWithStarredAndPinned(repos, octokit);

		expect(result.map((r) => r.fullName)).toEqual(["acme/a", "acme/b"]);
		expect(result.every((r) => !r.pinned)).toBe(true);
	});
});
