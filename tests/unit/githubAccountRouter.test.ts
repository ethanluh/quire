import { describe, it, expect, afterEach, jest } from "@jest/globals";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { request as httpRequest } from "node:http";
import type { Server } from "node:http";
import { githubAccountRouter } from "../../src/interface/server/routes/account.js";
import type { OAuthDeps } from "../../src/interface/server/routes/account.js";
import type { ConnectedAccount } from "../../src/engine/github/account.js";
import { GitHubClientHolder } from "../../src/engine/github/clientHolder.js";
import { StubGitHubClient } from "../../src/engine/github/stubClient.js";
import { OctokitGitHubClient } from "../../src/engine/github/octokitClient.js";
import { InvalidTokenError } from "../../src/engine/github/verifyToken.js";
import type { VerifiedTokenIdentity } from "../../src/engine/github/verifyToken.js";
import type { RepoSummary } from "../../src/engine/github/repos.js";
import type { RawPRPayload } from "../../src/engine/github/client.js";
import { OAuthExchangeError } from "../../src/engine/github/oauth.js";
import { createServerState } from "../../src/interface/server/state.js";
import { errorHandler } from "../../src/interface/server/middleware/errors.js";
import { AuditStore } from "../../src/engine/gate/auditStore.js";
import { StubLlmProvider } from "../mocks/llmProvider.js";
import { StubStaticAnalyzer } from "../mocks/staticAnalyzer.js";
import type { ServerState } from "../../src/interface/server/state.js";
import type { PipelineConfig } from "../../src/engine/pipeline/pipeline.js";
import type { PipelineDeps } from "../../src/interface/server/ingestIntoQueue.js";

const PIPELINE_CONFIG: PipelineConfig = {
	gate: { criteria: [{ name: "buildFailure", mode: "enforce" }] },
	bundle: { similarityThreshold: 0.75 },
};

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

interface RedirectResponse {
	status: number;
	location: string | undefined;
}

// The OAuth callback always responds with a redirect (never JSON) — global fetch()'s
// default redirect mode follows it, which would then 404 against this test app's bare
// router (no static index.html mounted here), so this uses node:http directly to inspect
// the redirect itself without following it.
async function callRedirect(server: Server, path: string): Promise<RedirectResponse> {
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("no address");
	return new Promise((resolve, reject) => {
		const req = httpRequest({ host: "127.0.0.1", port: address.port, path }, (res) => {
			res.resume();
			res.on("end", () => resolve({ status: res.statusCode ?? 0, location: res.headers.location }));
		});
		req.on("error", reject);
		req.end();
	});
}

function makePrFixture(overrides: Partial<RawPRPayload> = {}): RawPRPayload {
	return {
		id: "pr-1",
		number: 1,
		owner: "octocat",
		repo: "hello-world",
		title: "Add OTP login",
		body: "",
		diff: "diff --git a/src/auth.ts b/src/auth.ts\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -0,0 +1 @@\n+export function login() {}\n",
		ciStatus: "success",
		declaredDirection: "add passwordless auth",
		filesTouched: ["src/auth.ts"],
		...overrides,
	};
}

// Returns a different fixed set of PRs on each successive call, so a test can simulate
// a repo's open-PR set changing between two selections of the same repo.
class SequencedGitHubClient extends StubGitHubClient {
	private call = 0;
	constructor(private readonly responses: ReadonlyArray<ReadonlyArray<RawPRPayload>>) {
		super();
	}
	override async listOpenPullRequests(): Promise<ReadonlyArray<RawPRPayload>> {
		const response = this.responses[this.call] ?? [];
		this.call++;
		return response;
	}
}

class ThrowingGitHubClient extends StubGitHubClient {
	override async listOpenPullRequests(): Promise<never> {
		throw new Error("GitHub API unavailable");
	}
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
		client: StubGitHubClient = new StubGitHubClient(),
		provider: StubLlmProvider = new StubLlmProvider(),
		initialAccount: ConnectedAccount | undefined = undefined,
		depsOverrides: Partial<Pick<PipelineDeps, "auditStore" | "config">> = {},
		oauthDeps: OAuthDeps | undefined = undefined,
	): { accountPath: string; holder: GitHubClientHolder; state: ServerState } {
		const accountPath = join(dir, "github-account.json");
		const holder = new GitHubClientHolder(client);
		const state = createServerState();
		const deps: PipelineDeps = {
			config: depsOverrides.config ?? PIPELINE_CONFIG,
			provider,
			analyzer: new StubStaticAnalyzer(),
			auditStore: depsOverrides.auditStore ?? new AuditStore(),
		};
		const app = express();
		app.use(express.json());
		app.use(
			"/account/github",
			githubAccountRouter(
				accountPath,
				holder,
				fallbackToken,
				verifyToken,
				listRepos,
				initialAccount,
				state,
				deps,
				oauthDeps,
			),
		);
		app.use(errorHandler);
		server = app.listen(0);
		return { accountPath, holder, state };
	}

	function makeOAuthDeps(
		exchangeCodeForToken: OAuthDeps["exchangeCodeForToken"] = async () => ({ accessToken: "oauth-access-token" }),
	): OAuthDeps {
		return {
			config: { clientId: "client-id", clientSecret: "client-secret" },
			buildAuthorizeUrl: (config, redirectUri, state) =>
				`https://github.com/login/oauth/authorize?client_id=${config.clientId}&redirect_uri=${redirectUri}&state=${state}`,
			exchangeCodeForToken,
			redirectUri: "http://localhost:3000/account/github/oauth/callback",
		};
	}

	async function startOAuth(server: Server): Promise<string> {
		const { body } = await call(server, "POST", "/account/github/oauth/start", undefined, ADMIN_HEADERS);
		const authorizeUrl = body["authorizeUrl"] as string;
		const state = new URL(authorizeUrl).searchParams.get("state");
		if (state === null) throw new Error("authorizeUrl had no state param");
		return state;
	}

	it("reports not connected when no account has been set up", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-account-router-"));
		setup(async () => ({ login: "octocat", scopes: [] }));
		await new Promise((resolve) => server.once("listening", resolve));

		const { status, body } = await call(server, "GET", "/account/github/status");

		expect(status).toBe(200);
		expect(body).toEqual({ connected: false, oauthAvailable: false });
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
		expect(statusResult.body).toEqual({ connected: false, oauthAvailable: false });
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
		// Uses initialAccount rather than /connect: connecting for real would swap the
		// holder to a network-backed OctokitGitHubClient, and selecting a repo now also
		// fetches that repo's open PRs (see below), which would then hit the network.
		const { accountPath } = setup(
			async () => ({ login: "octocat", scopes: [] }),
			undefined,
			undefined,
			new StubGitHubClient(),
			new StubLlmProvider(),
			{ login: "octocat", token: "ghp_abc", scopes: [], connectedAt: "2026-06-30T00:00:00.000Z" },
		);
		await new Promise((resolve) => server.once("listening", resolve));

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

	it("ingests the selected repo's open PRs into the review queue", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-account-router-"));
		const client = new StubGitHubClient();
		client.addFixture("octocat", "hello-world", makePrFixture());
		const provider = new StubLlmProvider();
		provider.queueCompletion('["adds OTP login"]');
		provider.queueCompletion(JSON.stringify([{ clause: "adds OTP login", matchedDirection: true }]));
		// initialAccount pre-connects without going through /connect, which would swap the
		// holder to a real OctokitGitHubClient (and hit the network) instead of `client`.
		const { state } = setup(
			async () => ({ login: "octocat", scopes: [] }),
			undefined,
			undefined,
			client,
			provider,
			{ login: "octocat", token: "ghp_abc", scopes: [], connectedAt: "2026-06-30T00:00:00.000Z" },
		);
		await new Promise((resolve) => server.once("listening", resolve));

		const { status, body } = await call(
			server,
			"POST",
			"/account/github/repos/select",
			{ owner: "octocat", name: "hello-world" },
			ADMIN_HEADERS,
		);

		expect(status).toBe(200);
		expect(body["bundlesCreated"]).toBe(1);
		expect(state.cards.size).toBe(1);
		expect(state.bundles.size).toBe(1);
		const [card] = [...state.cards.values()];
		expect(card?.directionSummary).toBe("add passwordless auth");
	});

	it("selecting a repo with no open PRs leaves the review queue empty", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-account-router-"));
		const { state } = setup(
			async () => ({ login: "octocat", scopes: [] }),
			undefined,
			undefined,
			new StubGitHubClient(),
			new StubLlmProvider(),
			{ login: "octocat", token: "ghp_abc", scopes: [], connectedAt: "2026-06-30T00:00:00.000Z" },
		);
		await new Promise((resolve) => server.once("listening", resolve));

		const { status, body } = await call(
			server,
			"POST",
			"/account/github/repos/select",
			{ owner: "octocat", name: "hello-world" },
			ADMIN_HEADERS,
		);

		expect(status).toBe(200);
		expect(body["bundlesCreated"]).toBe(0);
		expect(state.cards.size).toBe(0);
	});

	it("does not persist the repo selection when fetching its open PRs fails, leaving the previous selection intact", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-account-router-"));
		const { accountPath } = setup(
			async () => ({ login: "octocat", scopes: [] }),
			undefined,
			undefined,
			new ThrowingGitHubClient(),
			new StubLlmProvider(),
			{
				login: "octocat",
				token: "ghp_abc",
				scopes: [],
				connectedAt: "2026-06-30T00:00:00.000Z",
				selectedRepo: { owner: "octocat", name: "old-repo" },
			},
		);
		await new Promise((resolve) => server.once("listening", resolve));

		const { status } = await call(
			server,
			"POST",
			"/account/github/repos/select",
			{ owner: "octocat", name: "new-repo" },
			ADMIN_HEADERS,
		);

		expect(status).toBe(500);

		const statusResult = await call(server, "GET", "/account/github/status");
		expect(statusResult.body["selectedRepo"]).toEqual({ owner: "octocat", name: "old-repo" });
		// The account started as an in-memory initialAccount, never written to disk; a
		// failed select must not write it either.
		await expect(readFile(accountPath, "utf8")).rejects.toThrow();
	});

	it("clears bundles from a previously selected repo when switching to a different one", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-account-router-"));
		const client = new StubGitHubClient();
		client.addFixture(
			"octocat",
			"repo-a",
			makePrFixture({ id: "pr-a", repo: "repo-a", declaredDirection: "direction a", filesTouched: ["src/a.ts"] }),
		);
		client.addFixture(
			"octocat",
			"repo-b",
			makePrFixture({ id: "pr-b", repo: "repo-b", declaredDirection: "direction b", filesTouched: ["src/b.ts"] }),
		);
		const provider = new StubLlmProvider();
		provider.queueCompletion('["does a"]');
		provider.queueCompletion(JSON.stringify([{ clause: "does a", matchedDirection: true }]));
		provider.queueCompletion('["does b"]');
		provider.queueCompletion(JSON.stringify([{ clause: "does b", matchedDirection: true }]));
		const { state } = setup(
			async () => ({ login: "octocat", scopes: [] }),
			undefined,
			undefined,
			client,
			provider,
			{ login: "octocat", token: "ghp_abc", scopes: [], connectedAt: "2026-06-30T00:00:00.000Z" },
		);
		await new Promise((resolve) => server.once("listening", resolve));

		await call(server, "POST", "/account/github/repos/select", { owner: "octocat", name: "repo-a" }, ADMIN_HEADERS);
		expect(state.bundles.size).toBe(1);

		await call(server, "POST", "/account/github/repos/select", { owner: "octocat", name: "repo-b" }, ADMIN_HEADERS);

		expect(state.bundles.size).toBe(1);
		const [card] = [...state.cards.values()];
		expect(card?.directionSummary).toBe("direction b");
	});

	it("re-selecting the same repo replaces its bundles instead of accumulating stale ones", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-account-router-"));
		const client = new SequencedGitHubClient([
			[makePrFixture({ id: "pr-1", declaredDirection: "direction one", filesTouched: ["src/one.ts"] })],
			[makePrFixture({ id: "pr-2", declaredDirection: "direction two", filesTouched: ["src/two.ts"] })],
		]);
		const provider = new StubLlmProvider();
		provider.queueCompletion('["does one"]');
		provider.queueCompletion(JSON.stringify([{ clause: "does one", matchedDirection: true }]));
		provider.queueCompletion('["does two"]');
		provider.queueCompletion(JSON.stringify([{ clause: "does two", matchedDirection: true }]));
		const { state } = setup(
			async () => ({ login: "octocat", scopes: [] }),
			undefined,
			undefined,
			client,
			provider,
			{ login: "octocat", token: "ghp_abc", scopes: [], connectedAt: "2026-06-30T00:00:00.000Z" },
		);
		await new Promise((resolve) => server.once("listening", resolve));

		await call(server, "POST", "/account/github/repos/select", { owner: "octocat", name: "hello-world" }, ADMIN_HEADERS);
		expect(state.bundles.size).toBe(1);

		await call(server, "POST", "/account/github/repos/select", { owner: "octocat", name: "hello-world" }, ADMIN_HEADERS);

		expect(state.bundles.size).toBe(1);
		const [card] = [...state.cards.values()];
		expect(card?.directionSummary).toBe("direction two");
	});

	it("surfaces a partial pipeline failure in the response instead of silently succeeding", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-account-router-"));
		const client = new StubGitHubClient();
		client.addFixture("octocat", "hello-world", makePrFixture({ ciStatus: "failure" }));
		const blockerPath = join(dir, "blocker");
		await writeFile(blockerPath, "not a directory", "utf8");
		const brokenAuditStore = new AuditStore(join(blockerPath, "audit.ndjson"));

		setup(
			async () => ({ login: "octocat", scopes: [] }),
			undefined,
			undefined,
			client,
			new StubLlmProvider(),
			{ login: "octocat", token: "ghp_abc", scopes: [], connectedAt: "2026-06-30T00:00:00.000Z" },
			{
				auditStore: brokenAuditStore,
				config: { gate: { criteria: [{ name: "buildFailure", mode: "shadow" }] }, bundle: { similarityThreshold: 0.75 } },
			},
		);
		await new Promise((resolve) => server.once("listening", resolve));

		const { status, body } = await call(
			server,
			"POST",
			"/account/github/repos/select",
			{ owner: "octocat", name: "hello-world" },
			ADMIN_HEADERS,
		);

		expect(status).toBe(200);
		expect(body["error"]).toBeTruthy();
		expect(body["bundlesCreated"]).toBe(0);
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

	describe("OAuth connect", () => {
		it("hides the OAuth endpoints and reports oauthAvailable: false when no oauthDeps is configured", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-account-router-"));
			setup(async () => ({ login: "octocat", scopes: [] }));
			await new Promise((resolve) => server.once("listening", resolve));

			const start = await callRedirect(server, "/account/github/oauth/start");
			expect(start.status).toBe(404);

			const status = await call(server, "GET", "/account/github/status");
			expect(status.body["oauthAvailable"]).toBe(false);
		});

		it("reports oauthAvailable: true once oauthDeps is configured", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-account-router-"));
			setup(
				async () => ({ login: "octocat", scopes: [] }),
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				{},
				makeOAuthDeps(),
			);
			await new Promise((resolve) => server.once("listening", resolve));

			const status = await call(server, "GET", "/account/github/status");
			expect(status.body["oauthAvailable"]).toBe(true);
		});

		it("rejects /oauth/start missing the admin header", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-account-router-"));
			setup(
				async () => ({ login: "octocat", scopes: [] }),
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				{},
				makeOAuthDeps(),
			);
			await new Promise((resolve) => server.once("listening", resolve));

			const { status } = await call(server, "POST", "/account/github/oauth/start", undefined, {});

			expect(status).toBe(403);
		});

		it("returns a fresh authorize URL with a new state on each call", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-account-router-"));
			setup(
				async () => ({ login: "octocat", scopes: [] }),
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				{},
				makeOAuthDeps(),
			);
			await new Promise((resolve) => server.once("listening", resolve));

			const first = await startOAuth(server);
			const second = await startOAuth(server);

			expect(first).not.toBe(second);
		});

		it("connects via a valid code+state, persisting the account and swapping in an authenticated client", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-account-router-"));
			const exchangeCodeForToken = jest.fn(async () => ({ accessToken: "oauth-access-token" }));
			const { accountPath, holder } = setup(
				async (token) => {
					expect(token).toBe("oauth-access-token");
					return { login: "octocat", scopes: ["repo"] };
				},
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				{},
				makeOAuthDeps(exchangeCodeForToken),
			);
			const setClientSpy = jest.spyOn(holder, "setClient");
			await new Promise((resolve) => server.once("listening", resolve));
			const state = await startOAuth(server);

			const { status, location } = await callRedirect(
				server,
				`/account/github/oauth/callback?code=good-code&state=${state}`,
			);

			expect(status).toBe(302);
			expect(location).toBe("/?account=connected");
			expect(exchangeCodeForToken).toHaveBeenCalledTimes(1);
			expect(setClientSpy).toHaveBeenCalledTimes(1);
			expect(setClientSpy.mock.calls[0]?.[0]).toBeInstanceOf(OctokitGitHubClient);

			const persisted = JSON.parse(await readFile(accountPath, "utf8")) as Record<string, unknown>;
			expect(persisted["login"]).toBe("octocat");
			expect(persisted["token"]).toBe("oauth-access-token");
		});

		it("rejects a callback whose state doesn't match the pending one, without exchanging the code", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-account-router-"));
			const exchangeCodeForToken = jest.fn(async () => ({ accessToken: "oauth-access-token" }));
			const { accountPath } = setup(
				async () => ({ login: "octocat", scopes: [] }),
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				{},
				makeOAuthDeps(exchangeCodeForToken),
			);
			await new Promise((resolve) => server.once("listening", resolve));
			await startOAuth(server);

			const { status, location } = await callRedirect(server, "/account/github/oauth/callback?code=x&state=wrong-state");

			expect(status).toBe(302);
			expect(location).toContain("account=error");
			expect(exchangeCodeForToken).not.toHaveBeenCalled();
			await expect(readFile(accountPath, "utf8")).rejects.toThrow();
		});

		it("rejects a callback when no OAuth flow was ever started", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-account-router-"));
			const exchangeCodeForToken = jest.fn(async () => ({ accessToken: "oauth-access-token" }));
			setup(
				async () => ({ login: "octocat", scopes: [] }),
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				{},
				makeOAuthDeps(exchangeCodeForToken),
			);
			await new Promise((resolve) => server.once("listening", resolve));

			const { status, location } = await callRedirect(server, "/account/github/oauth/callback?code=x&state=anything");

			expect(status).toBe(302);
			expect(location).toContain("account=error");
			expect(exchangeCodeForToken).not.toHaveBeenCalled();
		});

		it("rejects a second callback that reuses an already-consumed code+state (one-time use)", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-account-router-"));
			const exchangeCodeForToken = jest.fn(async () => ({ accessToken: "oauth-access-token" }));
			setup(
				async () => ({ login: "octocat", scopes: [] }),
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				{},
				makeOAuthDeps(exchangeCodeForToken),
			);
			await new Promise((resolve) => server.once("listening", resolve));
			const state = await startOAuth(server);

			const first = await callRedirect(server, `/account/github/oauth/callback?code=good-code&state=${state}`);
			expect(first.status).toBe(302);
			expect(first.location).toBe("/?account=connected");

			const second = await callRedirect(server, `/account/github/oauth/callback?code=good-code&state=${state}`);

			expect(second.status).toBe(302);
			expect(second.location).toContain("account=error");
			expect(exchangeCodeForToken).toHaveBeenCalledTimes(1);
		});

		it("surfaces an OAuthExchangeError as an error page without persisting anything", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-account-router-"));
			const exchangeCodeForToken = jest.fn(async () => {
				throw new OAuthExchangeError("bad_verification_code");
			});
			const { accountPath } = setup(
				async () => ({ login: "octocat", scopes: [] }),
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				{},
				makeOAuthDeps(exchangeCodeForToken),
			);
			await new Promise((resolve) => server.once("listening", resolve));
			const state = await startOAuth(server);

			const { status, location } = await callRedirect(server, `/account/github/oauth/callback?code=bad&state=${state}`);

			expect(status).toBe(302);
			expect(location).toContain("account=error");
			expect(new URLSearchParams(location?.split("?")[1]).get("reason")).toContain("bad_verification_code");
			await expect(readFile(accountPath, "utf8")).rejects.toThrow();
		});

		it("surfaces a post-exchange InvalidTokenError as an error page without persisting anything", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-account-router-"));
			const { accountPath } = setup(
				async () => {
					throw new InvalidTokenError("GitHub rejected this token");
				},
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				{},
				makeOAuthDeps(),
			);
			await new Promise((resolve) => server.once("listening", resolve));
			const state = await startOAuth(server);

			const { status, location } = await callRedirect(server, `/account/github/oauth/callback?code=good&state=${state}`);

			expect(status).toBe(302);
			expect(location).toContain("account=error");
			expect(new URLSearchParams(location?.split("?")[1]).get("reason")).toBe("GitHub rejected this token");
			await expect(readFile(accountPath, "utf8")).rejects.toThrow();
		});
	});
});
