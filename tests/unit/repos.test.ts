import { describe, it, expect, jest } from "@jest/globals";
import type { Octokit } from "@octokit/rest";
import {
	listInstallationRepositories,
	enrichWithStarredAndPinned,
	fetchUserAccessibleRepoNames,
	filterReposAccessibleToUser,
	isRepoAccessibleToUser,
} from "../../src/engine/github/repos.js";
import type { RepoSummary } from "../../src/engine/github/repos.js";

// Same duck-typed HttpError shape octokitClient.test.ts's own fake uses — both the real
// @octokit/request-error's RequestError and this satisfy isHttpError's structural check.
class FakeHttpError extends Error {
	status: number;
	constructor(message: string, status: number) {
		super(message);
		this.name = "HttpError";
		this.status = status;
	}
}

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

		const repos = await listInstallationRepositories(octokit, 555, "acme-corp");

		expect(repos).toEqual([
			{
				owner: "octocat",
				name: "hello-world",
				fullName: "octocat/hello-world",
				private: false,
				defaultBranch: "main",
				installationId: 555,
				accountLogin: "acme-corp",
				starred: false,
				pinned: false,
			},
			{
				owner: "octocat",
				name: "secret-project",
				fullName: "octocat/secret-project",
				private: true,
				defaultBranch: "trunk",
				installationId: 555,
				accountLogin: "acme-corp",
				starred: false,
				pinned: false,
			},
		]);
	});

	it("returns an empty list when the installation has no accessible repos", async () => {
		const octokit = makeFakeOctokit([]);

		const repos = await listInstallationRepositories(octokit, 555, "acme-corp");

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

		const repos = await listInstallationRepositories(octokit, 555, "acme-corp");

		expect(repos).toEqual([
			{
				owner: "octocat",
				name: "hello-world",
				fullName: "octocat/hello-world",
				private: false,
				defaultBranch: "main",
				installationId: 555,
				accountLogin: "acme-corp",
				starred: false,
				pinned: false,
			},
		]);
	});
});

function repo(overrides: Partial<RepoSummary> & { fullName: string }): RepoSummary {
	return {
		owner: overrides.fullName.split("/")[0] ?? "",
		name: overrides.fullName.split("/")[1] ?? "",
		private: false,
		defaultBranch: "main",
		installationId: 555,
		accountLogin: "acme-corp",
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

function makeFakeAuthenticatedUserOctokit(fullNames: ReadonlyArray<string>, opts?: { fails?: boolean }): Octokit {
	const listForAuthenticatedUser = jest.fn();
	const paginate = jest.fn(async () => {
		if (opts?.fails === true) throw new Error("boom");
		return fullNames.map((full_name) => ({ full_name }));
	});
	return { rest: { repos: { listForAuthenticatedUser } }, paginate } as unknown as Octokit;
}

describe("fetchUserAccessibleRepoNames", () => {
	it("returns the paginated full-name set for the authenticated user", async () => {
		const octokit = makeFakeAuthenticatedUserOctokit(["acme/a", "acme/b"]);

		const names = await fetchUserAccessibleRepoNames(octokit);

		expect(names).toEqual(new Set(["acme/a", "acme/b"]));
	});

	it("throws rather than degrading to an empty set on failure — the caller decides the fallback", async () => {
		const octokit = makeFakeAuthenticatedUserOctokit([], { fails: true });

		await expect(fetchUserAccessibleRepoNames(octokit)).rejects.toThrow("boom");
	});
});

describe("filterReposAccessibleToUser", () => {
	it("keeps public repos and private repos in the user's own accessible set, drops the rest", async () => {
		const repos = [
			repo({ fullName: "acme/public", private: false }),
			repo({ fullName: "acme/shared-with-me", private: true }),
			repo({ fullName: "acme/not-mine", private: true }),
		];
		const octokit = makeFakeAuthenticatedUserOctokit(["acme/shared-with-me"]);

		const result = await filterReposAccessibleToUser(repos, octokit);

		expect(result.map((r) => r.fullName)).toEqual(["acme/public", "acme/shared-with-me"]);
	});

	it("fails closed to public-only when the user's accessible set can't be fetched", async () => {
		const repos = [repo({ fullName: "acme/public", private: false }), repo({ fullName: "acme/private", private: true })];
		const octokit = makeFakeAuthenticatedUserOctokit([], { fails: true });

		const result = await filterReposAccessibleToUser(repos, octokit);

		expect(result.map((r) => r.fullName)).toEqual(["acme/public"]);
	});
});

function makeFakeSingleRepoOctokit(opts: { rejects?: Error }): Octokit {
	const get = jest.fn(async () => {
		if (opts.rejects !== undefined) throw opts.rejects;
		return { data: {} };
	});
	return { rest: { repos: { get } } } as unknown as Octokit;
}

describe("isRepoAccessibleToUser", () => {
	it("returns true when GitHub's repos.get succeeds for the user's token", async () => {
		const octokit = makeFakeSingleRepoOctokit({});

		await expect(isRepoAccessibleToUser("acme", "widgets", octokit)).resolves.toBe(true);
	});

	it("returns false on a 404 (repo doesn't exist, or isn't visible to this user)", async () => {
		const octokit = makeFakeSingleRepoOctokit({ rejects: new FakeHttpError("Not Found", 404) });

		await expect(isRepoAccessibleToUser("acme", "widgets", octokit)).resolves.toBe(false);
	});

	it("returns false on a 403 (visible to the installation, but not to this user)", async () => {
		const octokit = makeFakeSingleRepoOctokit({ rejects: new FakeHttpError("Forbidden", 403) });

		await expect(isRepoAccessibleToUser("acme", "widgets", octokit)).resolves.toBe(false);
	});

	it("rethrows on an unrelated failure rather than treating it as 'no access'", async () => {
		const octokit = makeFakeSingleRepoOctokit({ rejects: new FakeHttpError("Server error", 500) });

		await expect(isRepoAccessibleToUser("acme", "widgets", octokit)).rejects.toThrow("Server error");
	});
});
