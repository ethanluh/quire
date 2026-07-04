import { describe, it, expect, jest, afterEach } from "@jest/globals";
import type { Octokit } from "@octokit/rest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addTeamMemberAsCollaborator, removeTeamMemberAsCollaborator } from "../../src/engine/github/collaborators.js";
import type { BuildOctokit } from "../../src/engine/github/collaborators.js";
import { saveInstallation } from "../../src/engine/github/installation.js";
import type { InstallationBinding, RepoBinding } from "../../src/engine/github/installation.js";

// Same duck-typed HttpError shape octokitClient.test.ts's own fake uses — both the real
// @octokit/rest and @octokit/request-error copies only agree on name/status, never on
// class identity.
class FakeHttpError extends Error {
	readonly status: number;
	constructor(message: string, status: number) {
		super(message);
		this.name = "HttpError";
		this.status = status;
	}
}

const BINDING: InstallationBinding = {
	installationId: 42,
	accountLogin: "octocat",
	accountType: "Organization",
	boundAt: "2026-06-30T00:00:00.000Z",
};

function repoBindingFixture(overrides: Partial<RepoBinding> & { owner: string; name: string; installationId: number }): RepoBinding {
	return { addedAt: "2026-06-30T00:00:00.000Z", addedBy: "octocat", ...overrides };
}

function makeFakeOctokit(opts: { addRejects?: Error; removeRejects?: Error } = {}): {
	octokit: Octokit;
	addCollaborator: jest.Mock;
	removeCollaborator: jest.Mock;
} {
	const addCollaborator = jest.fn(async () => {
		if (opts.addRejects !== undefined) throw opts.addRejects;
	});
	const removeCollaborator = jest.fn(async () => {
		if (opts.removeRejects !== undefined) throw opts.removeRejects;
	});
	const octokit = { rest: { repos: { addCollaborator, removeCollaborator } } } as unknown as Octokit;
	return { octokit, addCollaborator, removeCollaborator };
}

describe("collaborators", () => {
	let dir: string;

	afterEach(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	async function tempInstallationPath(): Promise<string> {
		dir = await mkdtemp(join(tmpdir(), "quire-collaborators-"));
		return join(dir, "installation.json");
	}

	it("skips (no repos bound) when installation.json doesn't exist", async () => {
		const path = await tempInstallationPath();
		const buildOctokit = jest.fn() as unknown as BuildOctokit;

		const results = await addTeamMemberAsCollaborator(buildOctokit, path, "bob", "member");

		expect(results).toEqual([]);
		expect(buildOctokit).not.toHaveBeenCalled();
	});

	it("skips (no repos bound) when installation.json exists but repos is empty", async () => {
		const path = await tempInstallationPath();
		await saveInstallation(path, { installations: [BINDING], repos: [] });
		const buildOctokit = jest.fn() as unknown as BuildOctokit;

		const results = await removeTeamMemberAsCollaborator(buildOctokit, path, "bob");

		expect(results).toEqual([]);
		expect(buildOctokit).not.toHaveBeenCalled();
	});

	const ROLE_PERMISSION_CASES: Array<["owner" | "admin" | "member", "push" | "pull"]> = [
		["owner", "push"],
		["admin", "push"],
		["member", "pull"],
	];

	it.each(ROLE_PERMISSION_CASES)("adds a collaborator with %s -> %s permission", async (role, permission) => {
		const path = await tempInstallationPath();
		const repo = repoBindingFixture({ owner: "acme-corp", name: "widgets", installationId: 42 });
		await saveInstallation(path, { installations: [BINDING], repos: [repo] });
		const { octokit, addCollaborator } = makeFakeOctokit();
		const buildOctokit = jest.fn(() => octokit) as unknown as BuildOctokit;

		const results = await addTeamMemberAsCollaborator(buildOctokit, path, "bob", role);

		expect(buildOctokit).toHaveBeenCalledWith(42);
		expect(addCollaborator).toHaveBeenCalledWith({ owner: "acme-corp", repo: "widgets", username: "bob", permission });
		expect(results).toEqual([{ owner: "acme-corp", name: "widgets", outcome: "added" }]);
	});

	it("syncs every bound repo independently, even across different installations", async () => {
		const path = await tempInstallationPath();
		const repoA = repoBindingFixture({ owner: "acme-corp", name: "widgets", installationId: 42 });
		const repoB = repoBindingFixture({ owner: "octocat", name: "gadgets", installationId: 43 });
		await saveInstallation(path, { installations: [BINDING], repos: [repoA, repoB] });
		const { octokit, addCollaborator } = makeFakeOctokit();
		const buildOctokit = jest.fn(() => octokit) as unknown as BuildOctokit;

		const results = await addTeamMemberAsCollaborator(buildOctokit, path, "bob", "member");

		expect(buildOctokit).toHaveBeenCalledWith(42);
		expect(buildOctokit).toHaveBeenCalledWith(43);
		expect(addCollaborator).toHaveBeenCalledTimes(2);
		expect(results).toHaveLength(2);
		expect(results).toEqual(
			expect.arrayContaining([
				{ owner: "acme-corp", name: "widgets", outcome: "added" },
				{ owner: "octocat", name: "gadgets", outcome: "added" },
			]),
		);
	});

	it("classifies a 403 'insufficient permission' add failure without throwing", async () => {
		const path = await tempInstallationPath();
		const repo = repoBindingFixture({ owner: "acme-corp", name: "widgets", installationId: 42 });
		await saveInstallation(path, { installations: [BINDING], repos: [repo] });
		const { octokit } = makeFakeOctokit({ addRejects: new FakeHttpError("Resource not accessible by integration", 403) });
		const buildOctokit = jest.fn(() => octokit) as unknown as BuildOctokit;

		const results = await addTeamMemberAsCollaborator(buildOctokit, path, "bob", "member");

		expect(results).toEqual([
			{ owner: "acme-corp", name: "widgets", outcome: "failed", reason: "insufficient-permission", error: expect.anything() },
		]);
	});

	it("classifies any other GitHub error as a generic failure without throwing", async () => {
		const path = await tempInstallationPath();
		const repo = repoBindingFixture({ owner: "acme-corp", name: "widgets", installationId: 42 });
		await saveInstallation(path, { installations: [BINDING], repos: [repo] });
		const { octokit } = makeFakeOctokit({ addRejects: new FakeHttpError("Server error", 500) });
		const buildOctokit = jest.fn(() => octokit) as unknown as BuildOctokit;

		const results = await addTeamMemberAsCollaborator(buildOctokit, path, "bob", "member");

		expect(results).toEqual([
			{ owner: "acme-corp", name: "widgets", outcome: "failed", reason: "github-error", error: expect.anything() },
		]);
	});

	it("removes a collaborator", async () => {
		const path = await tempInstallationPath();
		const repo = repoBindingFixture({ owner: "acme-corp", name: "widgets", installationId: 42 });
		await saveInstallation(path, { installations: [BINDING], repos: [repo] });
		const { octokit, removeCollaborator } = makeFakeOctokit();
		const buildOctokit = jest.fn(() => octokit) as unknown as BuildOctokit;

		const results = await removeTeamMemberAsCollaborator(buildOctokit, path, "bob");

		expect(removeCollaborator).toHaveBeenCalledWith({ owner: "acme-corp", repo: "widgets", username: "bob" });
		expect(results).toEqual([{ owner: "acme-corp", name: "widgets", outcome: "removed" }]);
	});

	it("treats a 404 on remove as success, not failure", async () => {
		const path = await tempInstallationPath();
		const repo = repoBindingFixture({ owner: "acme-corp", name: "widgets", installationId: 42 });
		await saveInstallation(path, { installations: [BINDING], repos: [repo] });
		const { octokit } = makeFakeOctokit({ removeRejects: new FakeHttpError("Not Found", 404) });
		const buildOctokit = jest.fn(() => octokit) as unknown as BuildOctokit;

		const results = await removeTeamMemberAsCollaborator(buildOctokit, path, "bob");

		expect(results).toEqual([{ owner: "acme-corp", name: "widgets", outcome: "removed" }]);
	});

	it("classifies a 403 'insufficient permission' remove failure without throwing", async () => {
		const path = await tempInstallationPath();
		const repo = repoBindingFixture({ owner: "acme-corp", name: "widgets", installationId: 42 });
		await saveInstallation(path, { installations: [BINDING], repos: [repo] });
		const { octokit } = makeFakeOctokit({ removeRejects: new FakeHttpError("Resource not accessible by integration", 403) });
		const buildOctokit = jest.fn(() => octokit) as unknown as BuildOctokit;

		const results = await removeTeamMemberAsCollaborator(buildOctokit, path, "bob");

		expect(results).toEqual([
			{ owner: "acme-corp", name: "widgets", outcome: "failed", reason: "insufficient-permission", error: expect.anything() },
		]);
	});

	it("caps concurrent in-flight GitHub calls instead of firing every bound repo's call at once", async () => {
		const path = await tempInstallationPath();
		const repos = Array.from({ length: 10 }, (_, i) =>
			repoBindingFixture({ owner: "acme-corp", name: `repo-${i}`, installationId: 42 }),
		);
		await saveInstallation(path, { installations: [BINDING], repos });

		let inFlight = 0;
		let maxInFlight = 0;
		const addCollaborator = jest.fn(async () => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise((resolve) => setTimeout(resolve, 5));
			inFlight--;
		});
		const octokit = { rest: { repos: { addCollaborator } } } as unknown as Octokit;
		const buildOctokit = jest.fn(() => octokit) as unknown as BuildOctokit;

		const results = await addTeamMemberAsCollaborator(buildOctokit, path, "bob", "member");

		expect(results).toHaveLength(10);
		expect(addCollaborator).toHaveBeenCalledTimes(10);
		expect(maxInFlight).toBeLessThanOrEqual(4);
		expect(maxInFlight).toBeGreaterThan(1); // still genuinely concurrent, not serialized to 1
	});
});
