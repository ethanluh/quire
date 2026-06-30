import { describe, it, expect, afterEach, jest } from "@jest/globals";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import type { Server } from "node:http";
import { githubAccountRouter } from "../../src/interface/server/routes/account.js";
import { GitHubClientHolder } from "../../src/engine/github/clientHolder.js";
import { StubGitHubClient } from "../../src/engine/github/stubClient.js";
import { OctokitGitHubClient } from "../../src/engine/github/octokitClient.js";
import { InvalidTokenError } from "../../src/engine/github/verifyToken.js";
import type { VerifiedTokenIdentity } from "../../src/engine/github/verifyToken.js";
import type { RepoSummary } from "../../src/engine/github/repos.js";

interface JsonResponse {
	status: number;
	body: Record<string, unknown>;
}

async function call(
	server: Server,
	method: string,
	path: string,
	body?: unknown,
	headers: Record<string, string> = {},
): Promise<JsonResponse> {
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("no address");
	const init: RequestInit = { method, headers: { "Content-Type": "application/json", ...headers } };
	if (body !== undefined) init.body = JSON.stringify(body);
	const res = await fetch(`http://127.0.0.1:${address.port}${path}`, init);
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const ADMIN_HEADERS = { "X-Quire-Admin": "1" };

describe("githubAccountRouter", () => {
	let dir: string;
	let server: Server;

	afterEach(async () => {
		if (server) await new Promise((resolve) => server.close(resolve));
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	function setup(
		verifyToken: (token: string) => Promise<VerifiedTokenIdentity>,
		fallbackToken: string | undefined = undefined,
		listRepos: (token: string) => Promise<ReadonlyArray<RepoSummary>> = async () => [],
	): { accountPath: string; holder: GitHubClientHolder } {
		const accountPath = join(dir, "github-account.json");
		const holder = new GitHubClientHolder(new StubGitHubClient());
		const app = express();
		app.use(express.json());
		app.use(
			"/account/github",
			githubAccountRouter(accountPath, holder, fallbackToken, verifyToken, listRepos, undefined),
		);
		server = app.listen(0);
		return { accountPath, holder };
	}

	it("reports not connected when no account has been set up", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-account-router-"));
		setup(async () => ({ login: "octocat", scopes: [] }));
		await new Promise((resolve) => server.once("listening", resolve));

		const { status, body } = await call(server, "GET", "/account/github/status");

		expect(status).toBe(200);
		expect(body).toEqual({ connected: false });
	});

	it("connects, persists the account, and swaps in an authenticated client", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-account-router-"));
		const { accountPath, holder } = setup(async () => ({ login: "octocat", scopes: ["repo"] }));
		const setClientSpy = jest.spyOn(holder, "setClient");
		await new Promise((resolve) => server.once("listening", resolve));

		const { status, body } = await call(
			server,
			"POST",
			"/account/github/connect",
			{ token: "ghp_abc" },
			ADMIN_HEADERS,
		);

		expect(status).toBe(200);
		expect(body).toEqual(
			expect.objectContaining({ connected: true, login: "octocat", scopes: ["repo"] }),
		);
		expect(setClientSpy).toHaveBeenCalledTimes(1);
		expect(setClientSpy.mock.calls[0]?.[0]).toBeInstanceOf(OctokitGitHubClient);

		const persisted = JSON.parse(await readFile(accountPath, "utf8")) as Record<string, unknown>;
		expect(persisted["login"]).toBe("octocat");
		expect(persisted["token"]).toBe("ghp_abc");

		const statusResult = await call(server, "GET", "/account/github/status");
		expect(statusResult.body).toEqual(
			expect.objectContaining({ connected: true, login: "octocat", scopes: ["repo"] }),
		);
	});

	it("rejects connect attempts missing the admin header (CSRF guard) without storing anything", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-account-router-"));
		const { accountPath } = setup(async () => ({ login: "octocat", scopes: [] }));
		await new Promise((resolve) => server.once("listening", resolve));

		const { status } = await call(server, "POST", "/account/github/connect", { token: "ghp_abc" }, {});

		expect(status).toBe(403);
		await expect(readFile(accountPath, "utf8")).rejects.toThrow();
	});

	it("returns 400 and stores nothing when GitHub rejects the token", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-account-router-"));
		const { accountPath } = setup(async () => {
			throw new InvalidTokenError("GitHub rejected this token");
		});
		await new Promise((resolve) => server.once("listening", resolve));

		const { status, body } = await call(
			server,
			"POST",
			"/account/github/connect",
			{ token: "bad-token" },
			ADMIN_HEADERS,
		);

		expect(status).toBe(400);
		expect(body["error"]).toBe("GitHub rejected this token");
		await expect(readFile(accountPath, "utf8")).rejects.toThrow();
	});

	it("rejects a connect body with no token", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-account-router-"));
		setup(async () => ({ login: "octocat", scopes: [] }));
		await new Promise((resolve) => server.once("listening", resolve));

		const { status } = await call(server, "POST", "/account/github/connect", {}, ADMIN_HEADERS);

		expect(status).toBe(400);
	});

	it("disconnects, clears the persisted account, and falls back to the stub client when no GITHUB_TOKEN is set", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-account-router-"));
		const { accountPath, holder } = setup(async () => ({ login: "octocat", scopes: [] }));
		await new Promise((resolve) => server.once("listening", resolve));
		await call(server, "POST", "/account/github/connect", { token: "ghp_abc" }, ADMIN_HEADERS);
		const setClientSpy = jest.spyOn(holder, "setClient");

		const { status, body } = await call(server, "POST", "/account/github/disconnect", undefined, ADMIN_HEADERS);

		expect(status).toBe(200);
		expect(body).toEqual({ connected: false });
		expect(setClientSpy).toHaveBeenCalledTimes(1);
		expect(setClientSpy.mock.calls[0]?.[0]).toBeInstanceOf(StubGitHubClient);
		await expect(readFile(accountPath, "utf8")).rejects.toThrow();

		const statusResult = await call(server, "GET", "/account/github/status");
		expect(statusResult.body).toEqual({ connected: false });
	});

	it("rejects disconnect attempts missing the admin header", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-account-router-"));
		setup(async () => ({ login: "octocat", scopes: [] }));
		await new Promise((resolve) => server.once("listening", resolve));
		await call(server, "POST", "/account/github/connect", { token: "ghp_abc" }, ADMIN_HEADERS);

		const { status } = await call(server, "POST", "/account/github/disconnect", undefined, {});

		expect(status).toBe(403);
		const statusResult = await call(server, "GET", "/account/github/status");
		expect(statusResult.body).toEqual(expect.objectContaining({ connected: true }));
	});

	it("falls back to an authenticated client built from GITHUB_TOKEN on disconnect when one is set", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-account-router-"));
		const { holder } = setup(async () => ({ login: "octocat", scopes: [] }), "env-token");
		await new Promise((resolve) => server.once("listening", resolve));
		await call(server, "POST", "/account/github/connect", { token: "ghp_abc" }, ADMIN_HEADERS);
		const setClientSpy = jest.spyOn(holder, "setClient");

		await call(server, "POST", "/account/github/disconnect", undefined, ADMIN_HEADERS);

		expect(setClientSpy.mock.calls[0]?.[0]).toBeInstanceOf(OctokitGitHubClient);
	});

	it("returns 400 for /repos when no account is connected", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-account-router-"));
		setup(async () => ({ login: "octocat", scopes: [] }));
		await new Promise((resolve) => server.once("listening", resolve));

		const { status, body } = await call(server, "GET", "/account/github/repos", undefined, ADMIN_HEADERS);

		expect(status).toBe(400);
		expect(body["error"]).toBe("Connect a GitHub account first");
	});

	it("lists repos for the connected account's token", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-account-router-"));
		const repos: ReadonlyArray<RepoSummary> = [
			{ owner: "octocat", name: "hello-world", fullName: "octocat/hello-world", private: false, defaultBranch: "main" },
		];
		const listRepos = jest.fn(async (token: string) => {
			expect(token).toBe("ghp_abc");
			return repos;
		});
		setup(async () => ({ login: "octocat", scopes: [] }), undefined, listRepos);
		await new Promise((resolve) => server.once("listening", resolve));
		await call(server, "POST", "/account/github/connect", { token: "ghp_abc" }, ADMIN_HEADERS);

		const { status, body } = await call(server, "GET", "/account/github/repos", undefined, ADMIN_HEADERS);

		expect(status).toBe(200);
		expect(body["repos"]).toEqual(repos);
		expect(body["selected"]).toBeUndefined();
		expect(listRepos).toHaveBeenCalledTimes(1);
	});

	it("selects a repo and persists it, surfacing it on status and /repos", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-account-router-"));
		const { accountPath } = setup(async () => ({ login: "octocat", scopes: [] }));
		await new Promise((resolve) => server.once("listening", resolve));
		await call(server, "POST", "/account/github/connect", { token: "ghp_abc" }, ADMIN_HEADERS);

		const { status, body } = await call(
			server,
			"POST",
			"/account/github/repos/select",
			{ owner: "octocat", name: "hello-world" },
			ADMIN_HEADERS,
		);

		expect(status).toBe(200);
		expect(body["selected"]).toEqual({ owner: "octocat", name: "hello-world" });

		const persisted = JSON.parse(await readFile(accountPath, "utf8")) as Record<string, unknown>;
		expect(persisted["selectedRepo"]).toEqual({ owner: "octocat", name: "hello-world" });

		const statusResult = await call(server, "GET", "/account/github/status");
		expect(statusResult.body["selectedRepo"]).toEqual({ owner: "octocat", name: "hello-world" });
	});

	it("rejects repo selection when no account is connected", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-account-router-"));
		setup(async () => ({ login: "octocat", scopes: [] }));
		await new Promise((resolve) => server.once("listening", resolve));

		const { status, body } = await call(
			server,
			"POST",
			"/account/github/repos/select",
			{ owner: "octocat", name: "hello-world" },
			ADMIN_HEADERS,
		);

		expect(status).toBe(400);
		expect(body["error"]).toBe("Connect a GitHub account first");
	});

	it("rejects repo selection missing the admin header", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-account-router-"));
		setup(async () => ({ login: "octocat", scopes: [] }));
		await new Promise((resolve) => server.once("listening", resolve));
		await call(server, "POST", "/account/github/connect", { token: "ghp_abc" }, ADMIN_HEADERS);

		const { status } = await call(
			server,
			"POST",
			"/account/github/repos/select",
			{ owner: "octocat", name: "hello-world" },
			{},
		);

		expect(status).toBe(403);
	});
});
