import { describe, it, expect, afterEach, jest } from "@jest/globals";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import { request as httpRequest } from "node:http";
import type { Server } from "node:http";
import { githubAppRouter } from "../../src/interface/server/routes/githubApp.js";
import type { TeamRole } from "../../src/engine/types/team.js";
import type { RepoSummary } from "../../src/engine/github/repos.js";
import { GitHubClientHolder } from "../../src/engine/github/clientHolder.js";
import { StubGitHubClient } from "../../src/engine/github/stubClient.js";
import { DecidedPrStore } from "../../src/engine/queue/decidedPrStore.js";
import { createServerState } from "../../src/interface/server/state.js";
import type { ServerState } from "../../src/interface/server/state.js";
import { createAccountState } from "../../src/interface/server/accountState.js";
import type { RefreshDeps } from "../../src/interface/server/refreshRepoQueue.js";
import { errorHandler } from "../../src/interface/server/middleware/errors.js";
import { AuditStore } from "../../src/engine/gate/auditStore.js";
import { PrEffectCache } from "../../src/engine/cache/prCache.js";
import { StubLlmProvider } from "../mocks/llmProvider.js";
import { CONFLICT_RESOLUTION_WORKFLOW_CONTENT, WORKFLOW_CONTENT } from "../../src/engine/github/repoSetup.js";
import { StubStaticAnalyzer } from "../mocks/staticAnalyzer.js";
import type { InstallationBinding } from "../../src/engine/github/installation.js";
import type { PipelineConfig } from "../../src/engine/pipeline/pipeline.js";
import type { PipelineDeps } from "../../src/interface/server/ingestIntoQueue.js";
import type { RawPRPayload } from "../../src/engine/github/client.js";
import type { InstallationAccount } from "../../src/engine/github/installationClient.js";
import { RequestError } from "@octokit/request-error";
import { createUserTokenCache } from "../../src/engine/github/userTokenCache.js";
import type { UserTokenCache } from "../../src/engine/github/userTokenCache.js";

const PIPELINE_CONFIG: PipelineConfig = {
	gate: { criteria: [{ name: "buildFailure", mode: "enforce" }] },
	bundle: { similarityThreshold: 0.75 },
};

function makePrFixture(overrides: Partial<RawPRPayload> = {}): RawPRPayload {
	return {
		id: "pr-1",
		number: 1,
		owner: "octocat",
		repo: "hello-world",
		title: "Add OTP login",
		body: "",
		headSha: "sha-1",
		diff: "diff --git a/src/auth.ts b/src/auth.ts\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -0,0 +1 @@\n+export function login() {}\n",
		ciStatus: "success",
		declaredDirection: "add passwordless auth",
		filesTouched: ["src/auth.ts"],
		...overrides,
	};
}

interface JsonResponse {
	status: number;
	body: Record<string, unknown>;
	setCookie: string | undefined;
}

async function call(server: Server, method: string, path: string, body?: unknown, cookie?: string): Promise<JsonResponse> {
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("no address");
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (cookie !== undefined) headers["Cookie"] = cookie;
	const init: RequestInit = { method, headers };
	if (body !== undefined) init.body = JSON.stringify(body);
	const res = await fetch(`http://127.0.0.1:${address.port}${path}`, init);
	return {
		status: res.status,
		body: (await res.json()) as Record<string, unknown>,
		setCookie: res.headers.get("set-cookie") ?? undefined,
	};
}

interface RedirectResponse {
	status: number;
	location: string | undefined;
}

async function callRedirect(server: Server, path: string, cookie?: string): Promise<RedirectResponse> {
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("no address");
	return new Promise((resolve, reject) => {
		const req = httpRequest(
			{ host: "127.0.0.1", port: address.port, path, headers: cookie !== undefined ? { cookie } : {} },
			(res) => {
				res.resume();
				res.on("end", () => resolve({ status: res.statusCode ?? 0, location: res.headers.location }));
			},
		);
		req.on("error", reject);
		req.end();
	});
}

// The install-state cookie's Set-Cookie header looks like "quire_install_state=<value>;
// Path=/; ..." — only the first segment is the actual Cookie-header-ready pair.
function cookiePair(setCookie: string | undefined): string {
	if (setCookie === undefined) throw new Error("expected a Set-Cookie header");
	return setCookie.split(";")[0] ?? "";
}

describe("githubAppRouter", () => {
	let dir: string;
	let server: Server;

	afterEach(async () => {
		if (server) await new Promise((resolve) => server.close(resolve));
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	function setup(
		listRepos: (installationId: number) => Promise<ReadonlyArray<RepoSummary>> = async () => [],
		client: StubGitHubClient = new StubGitHubClient(),
		provider: StubLlmProvider = new StubLlmProvider(),
		initialBinding: InstallationBinding | undefined = undefined,
		getInstallationAccount: (installationId: number) => Promise<InstallationAccount> = async () => ({
			accountLogin: "acme-corp",
			accountType: "Organization",
		}),
		role: TeamRole = "owner",
		// Simulates requireSession having already run and populated res.locals.login — this
		// router is mounted after that middleware in production (see index.ts), so tests that
		// care about the starred/pinned enrichment path (which reads res.locals.login) opt in
		// by passing a login here rather than standing up the whole session stack.
		loginForRequests: string | undefined = undefined,
		enrichWithUserToken: (repos: ReadonlyArray<RepoSummary>, accessToken: string) => Promise<ReadonlyArray<RepoSummary>> = async (
			repos,
		) => repos,
		isInstallationBoundToAnotherTeam: ((installationId: number) => boolean) | undefined = undefined,
	): { accountPath: string; preferencesPath: string; state: ServerState; refreshDeps: RefreshDeps; userTokenCache: UserTokenCache } {
		const accountPath = join(dir, "installation.json");
		const holder = new GitHubClientHolder(client);
		const state = createServerState();
		const accountState = createAccountState(initialBinding);
		const decidedStore = new DecidedPrStore(join(dir, "decided-prs.json"));
		const userTokenCache = createUserTokenCache();
		const deps: PipelineDeps = {
			config: PIPELINE_CONFIG,
			provider,
			analyzer: new StubStaticAnalyzer(),
			auditStore: new AuditStore(),
			prCache: new PrEffectCache(),
		};
		const preferencesPath = join(dir, "preferences.json");
		const refreshDeps: RefreshDeps = {
			accountState,
			accountPath,
			preferencesPath,
			clientHolder: holder,
			appConfig: { appId: "1", privateKey: "unused" },
			decidedStore,
			state,
			pipelineDeps: deps,
		};
		const app = express();
		app.use(express.json());
		app.use((_req: Request, res: Response, next: NextFunction) => {
			res.locals.membership = { teamId: "test-team", role };
			next();
		});
		if (loginForRequests !== undefined) {
			app.use((_req, res, next) => {
				res.locals.login = loginForRequests;
				next();
			});
		}
		app.use(
			"/account/github",
			githubAppRouter(
				refreshDeps,
				"quire-review",
				{ appId: "1", privateKey: "unused" },
				listRepos,
				getInstallationAccount,
				false,
				userTokenCache,
				enrichWithUserToken,
				isInstallationBoundToAnotherTeam,
			),
		);
		app.use(errorHandler);
		server = app.listen(0);
		return { accountPath, preferencesPath, state, refreshDeps, userTokenCache };
	}

	it("reports not connected when no installation is bound", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
		setup();
		await new Promise((resolve) => server.once("listening", resolve));

		const { status, body } = await call(server, "GET", "/account/github/status");

		expect(status).toBe(200);
		expect(body).toEqual({ connected: false, autoMergeOnAccept: false });
	});

	it("mints an installUrl pointing at the app's install page with a state param", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
		setup();
		await new Promise((resolve) => server.once("listening", resolve));

		const { status, body } = await call(server, "POST", "/account/github/install/start");

		expect(status).toBe(200);
		const url = new URL(body["installUrl"] as string);
		expect(url.origin + url.pathname).toBe("https://github.com/apps/quire-review/installations/new");
		expect(url.searchParams.get("state")).toBeTruthy();
	});

	it("mints a fresh state when no pending-state cookie is presented", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
		setup();
		await new Promise((resolve) => server.once("listening", resolve));

		const first = await call(server, "POST", "/account/github/install/start");
		const second = await call(server, "POST", "/account/github/install/start");

		const firstState = new URL(first.body["installUrl"] as string).searchParams.get("state");
		const secondState = new URL(second.body["installUrl"] as string).searchParams.get("state");
		expect(firstState).not.toBe(secondState);
	});

	it("reuses the pending state when the same browser calls /install/start twice (double-click / second tab)", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
		const repos: ReadonlyArray<RepoSummary> = [
			{ owner: "acme-corp", name: "widgets", fullName: "acme-corp/widgets", private: false, defaultBranch: "main", starred: false, pinned: false },
		];
		setup(async () => repos);
		await new Promise((resolve) => server.once("listening", resolve));

		const first = await call(server, "POST", "/account/github/install/start");
		const firstState = new URL(first.body["installUrl"] as string).searchParams.get("state");
		const firstCookie = cookiePair(first.setCookie);

		// A second tab, or a double-click, from the SAME browser — its cookie jar already
		// holds the first call's state cookie.
		const second = await call(server, "POST", "/account/github/install/start", undefined, firstCookie);
		const secondState = new URL(second.body["installUrl"] as string).searchParams.get("state");
		expect(secondState).toBe(firstState);

		// The first tab's already-rendered install URL (embedding `firstState`) still
		// completes successfully — the old singleton design's double-click tolerance,
		// restored without reintroducing cross-browser clobbering.
		const { status, location } = await callRedirect(
			server,
			`/account/github/install/callback?installation_id=555&state=${firstState}`,
			firstCookie,
		);
		expect(status).toBe(302);
		expect(location).toBe("/?account=connected");
	});

	it("does not let one browser's /install/start invalidate another's in-flight install", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
		const repos: ReadonlyArray<RepoSummary> = [
			{ owner: "acme-corp", name: "widgets", fullName: "acme-corp/widgets", private: false, defaultBranch: "main", starred: false, pinned: false },
		];
		setup(async () => repos);
		await new Promise((resolve) => server.once("listening", resolve));

		// Two independent browsers (cookie jars) both start an install around the same time.
		const browserA = await call(server, "POST", "/account/github/install/start");
		const browserB = await call(server, "POST", "/account/github/install/start");
		const stateA = new URL(browserA.body["installUrl"] as string).searchParams.get("state");

		// Browser A's callback fires after browser B has already started (and, under the
		// old shared-singleton design, would have clobbered A's pending state).
		const { status, location } = await callRedirect(
			server,
			`/account/github/install/callback?installation_id=555&state=${stateA}`,
			cookiePair(browserA.setCookie),
		);

		expect(status).toBe(302);
		expect(location).toBe("/?account=connected");
		expect(browserB.status).toBe(200);
	});

	it("binds the installation on a valid callback, persisting it and swapping in a real client", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
		const repos: ReadonlyArray<RepoSummary> = [
			{ owner: "acme-corp", name: "widgets", fullName: "acme-corp/widgets", private: false, defaultBranch: "main", starred: false, pinned: false },
		];
		const { accountPath } = setup(async () => repos);
		await new Promise((resolve) => server.once("listening", resolve));
		const start = await call(server, "POST", "/account/github/install/start");
		const state = new URL(start.body["installUrl"] as string).searchParams.get("state");

		const { status, location } = await callRedirect(
			server,
			`/account/github/install/callback?installation_id=555&state=${state}`,
			cookiePair(start.setCookie),
		);

		expect(status).toBe(302);
		expect(location).toBe("/?account=connected");

		const persisted = JSON.parse(await readFile(accountPath, "utf8")) as Record<string, unknown>;
		expect(persisted["installationId"]).toBe(555);
		expect(persisted["accountLogin"]).toBe("acme-corp");

		const statusResult = await call(server, "GET", "/account/github/status");
		expect(statusResult.body).toEqual(expect.objectContaining({ connected: true, accountLogin: "acme-corp" }));
	});

	it("refuses to bind an installation another team already has bound", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
		const { accountPath } = setup(
			async () => [],
			new StubGitHubClient(),
			new StubLlmProvider(),
			undefined,
			async () => ({ accountLogin: "acme-corp", accountType: "Organization" }),
			"owner",
			undefined,
			async (repos) => repos,
			() => true,
		);
		await new Promise((resolve) => server.once("listening", resolve));
		const start = await call(server, "POST", "/account/github/install/start");
		const state = new URL(start.body["installUrl"] as string).searchParams.get("state");

		const { status, location } = await callRedirect(
			server,
			`/account/github/install/callback?installation_id=555&state=${state}`,
			cookiePair(start.setCookie),
		);

		expect(status).toBe(302);
		expect(location).toBe("/?account=error&reason=this+GitHub+installation+is+already+connected+to+a+different+Quire+team");
		await expect(readFile(accountPath, "utf8")).rejects.toThrow();
	});

	it("derives accountType from the real installation instead of hardcoding it", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
		const { accountPath } = setup(
			async () => [],
			new StubGitHubClient(),
			new StubLlmProvider(),
			undefined,
			async () => ({ accountLogin: "octocat", accountType: "User" }),
		);
		await new Promise((resolve) => server.once("listening", resolve));
		const start = await call(server, "POST", "/account/github/install/start");
		const state = new URL(start.body["installUrl"] as string).searchParams.get("state");

		await callRedirect(
			server,
			`/account/github/install/callback?installation_id=777&state=${state}`,
			cookiePair(start.setCookie),
		);

		const persisted = JSON.parse(await readFile(accountPath, "utf8")) as Record<string, unknown>;
		expect(persisted["accountLogin"]).toBe("octocat");
		expect(persisted["accountType"]).toBe("User");
	});

	it("redirects gracefully when the installation was revoked before the callback completes", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
		const revokedError = new RequestError("Not Found", 404, {
			request: { method: "GET", url: "https://api.github.com/app/installations/555", headers: {}, body: undefined },
		});
		const { accountPath } = setup(
			async () => [],
			new StubGitHubClient(),
			new StubLlmProvider(),
			undefined,
			async () => {
				throw revokedError;
			},
		);
		await new Promise((resolve) => server.once("listening", resolve));
		const start = await call(server, "POST", "/account/github/install/start");
		const state = new URL(start.body["installUrl"] as string).searchParams.get("state");

		const { status, location } = await callRedirect(
			server,
			`/account/github/install/callback?installation_id=555&state=${state}`,
			cookiePair(start.setCookie),
		);

		expect(status).toBe(302);
		expect(location).toContain("account=error");
		await expect(readFile(accountPath, "utf8")).rejects.toThrow();
	});

	it("rejects an install callback whose state doesn't match the pending one", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
		const { accountPath } = setup();
		await new Promise((resolve) => server.once("listening", resolve));
		const start = await call(server, "POST", "/account/github/install/start");

		const { status, location } = await callRedirect(
			server,
			"/account/github/install/callback?installation_id=555&state=wrong",
			cookiePair(start.setCookie),
		);

		expect(status).toBe(302);
		expect(location).toContain("account=error");
		await expect(readFile(accountPath, "utf8")).rejects.toThrow();
	});

	it("rejects an install callback with no pending state cookie at all", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
		const { accountPath } = setup();
		await new Promise((resolve) => server.once("listening", resolve));

		const { status, location } = await callRedirect(
			server,
			"/account/github/install/callback?installation_id=555&state=anything",
		);

		expect(status).toBe(302);
		expect(location).toContain("account=error");
		await expect(readFile(accountPath, "utf8")).rejects.toThrow();
	});

	it("lists repos for the bound installation", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
		const repos: ReadonlyArray<RepoSummary> = [
			{ owner: "acme-corp", name: "widgets", fullName: "acme-corp/widgets", private: false, defaultBranch: "main", starred: false, pinned: false },
		];
		const listRepos = jest.fn(async (installationId: number) => {
			expect(installationId).toBe(555);
			return repos;
		});
		setup(listRepos, new StubGitHubClient(), new StubLlmProvider(), {
			installationId: 555,
			accountLogin: "acme-corp",
			accountType: "Organization",
			boundAt: "2026-06-30T00:00:00.000Z",
		});
		await new Promise((resolve) => server.once("listening", resolve));

		const { status, body } = await call(server, "GET", "/account/github/repos");

		expect(status).toBe(200);
		expect(body["repos"]).toEqual(repos);
		expect(listRepos).toHaveBeenCalledTimes(1);
	});

	it("enriches with starred/pinned status when a user token is cached for the requester", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
		const repos: ReadonlyArray<RepoSummary> = [
			{ owner: "acme-corp", name: "widgets", fullName: "acme-corp/widgets", private: false, defaultBranch: "main", starred: false, pinned: false },
			{ owner: "acme-corp", name: "gadgets", fullName: "acme-corp/gadgets", private: false, defaultBranch: "main", starred: false, pinned: false },
		];
		const enrichWithUserToken = jest.fn(async (input: ReadonlyArray<RepoSummary>, accessToken: string) =>
			input.map((r) => ({ ...r, starred: r.fullName === "acme-corp/gadgets" && accessToken === "user-token" })),
		);
		const { userTokenCache } = setup(
			async () => repos,
			new StubGitHubClient(),
			new StubLlmProvider(),
			{ installationId: 555, accountLogin: "acme-corp", accountType: "Organization", boundAt: "2026-06-30T00:00:00.000Z" },
			async () => ({ accountLogin: "acme-corp", accountType: "Organization" }),
			"owner",
			"octocat",
			enrichWithUserToken,
		);
		userTokenCache.set("octocat", { accessToken: "user-token", expiresAt: Date.now() + 60_000 });
		await new Promise((resolve) => server.once("listening", resolve));

		const { status, body } = await call(server, "GET", "/account/github/repos");

		expect(status).toBe(200);
		expect(enrichWithUserToken).toHaveBeenCalledTimes(1);
		expect(body["repos"]).toEqual([
			{ ...repos[0], starred: false },
			{ ...repos[1], starred: true },
		]);
	});

	it("skips enrichment (and never calls enrichWithUserToken) when no user token is cached for the requester", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
		const repos: ReadonlyArray<RepoSummary> = [
			{ owner: "acme-corp", name: "widgets", fullName: "acme-corp/widgets", private: false, defaultBranch: "main", starred: false, pinned: false },
		];
		const enrichWithUserToken = jest.fn(async (input: ReadonlyArray<RepoSummary>) => input);
		setup(
			async () => repos,
			new StubGitHubClient(),
			new StubLlmProvider(),
			{ installationId: 555, accountLogin: "acme-corp", accountType: "Organization", boundAt: "2026-06-30T00:00:00.000Z" },
			async () => ({ accountLogin: "acme-corp", accountType: "Organization" }),
			"owner",
			"octocat",
			enrichWithUserToken,
		);
		// Deliberately not calling userTokenCache.set — no cached token for "octocat".
		await new Promise((resolve) => server.once("listening", resolve));

		const { status, body } = await call(server, "GET", "/account/github/repos");

		expect(status).toBe(200);
		expect(enrichWithUserToken).not.toHaveBeenCalled();
		expect(body["repos"]).toEqual(repos);
	});

	it("returns 400 for /repos when no installation is bound", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
		setup();
		await new Promise((resolve) => server.once("listening", resolve));

		const { status, body } = await call(server, "GET", "/account/github/repos");

		expect(status).toBe(400);
		expect(body["error"]).toBe("Install the GitHub App first");
	});

	it("selects a repo, persists it, and ingests its open PRs", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
		const client = new StubGitHubClient();
		client.addFixture("acme-corp", "widgets", makePrFixture({ owner: "acme-corp", repo: "widgets" }));
		const provider = new StubLlmProvider();
		provider.queueCompletion('["adds OTP login"]');
		provider.queueCompletion(JSON.stringify([{ clause: "adds OTP login", matchedDirection: true }]));
		const { accountPath, state } = setup(async () => [], client, provider, {
			installationId: 555,
			accountLogin: "acme-corp",
			accountType: "Organization",
			boundAt: "2026-06-30T00:00:00.000Z",
		});
		await new Promise((resolve) => server.once("listening", resolve));

		const { status, body } = await call(server, "POST", "/account/github/repos/select", { owner: "acme-corp", name: "widgets" });

		expect(status).toBe(200);
		expect(body["selected"]).toEqual({ owner: "acme-corp", name: "widgets" });
		expect(body["bundlesCreated"]).toBe(1);
		expect(state.bundles.size).toBe(1);

		const persisted = JSON.parse(await readFile(accountPath, "utf8")) as Record<string, unknown>;
		expect(persisted["selectedRepo"]).toEqual({ owner: "acme-corp", name: "widgets" });
	});

	it("rejects repo selection when no installation is bound", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
		setup();
		await new Promise((resolve) => server.once("listening", resolve));

		const { status, body } = await call(server, "POST", "/account/github/repos/select", { owner: "acme-corp", name: "widgets" });

		expect(status).toBe(400);
		expect(body["error"]).toBe("Install the GitHub App first");
	});

	describe("POST /repos/setup", () => {
		it("opens a setup PR documenting and enforcing the declared-direction convention", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
			const client = new StubGitHubClient();
			setup(async () => [], client, new StubLlmProvider(), {
				installationId: 555,
				accountLogin: "acme-corp",
				accountType: "Organization",
				boundAt: "2026-06-30T00:00:00.000Z",
			});
			await new Promise((resolve) => server.once("listening", resolve));

			const { status, body } = await call(server, "POST", "/account/github/repos/setup", { owner: "acme-corp", name: "widgets" });

			expect(status).toBe(200);
			expect(body["status"]).toBe("created");
			expect(body["prUrl"]).toContain("acme-corp/widgets/pull/");
		});

		it("reports already-set-up without opening a PR when the conventions are already in place", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
			const client = new StubGitHubClient();
			client.seedFile(
				"acme-corp",
				"widgets",
				".github/pull_request_template.md",
				"## Declared direction\n\n<!-- declared-direction: ... -->\n",
			);
			client.seedFile("acme-corp", "widgets", ".github/workflows/quire-declared-direction.yml", WORKFLOW_CONTENT);
			client.seedFile("acme-corp", "widgets", ".github/workflows/quire-resolve-conflict.yml", CONFLICT_RESOLUTION_WORKFLOW_CONTENT);
			client.seedFile("acme-corp", "widgets", "CLAUDE.md", "# CLAUDE.md\n\n## Quire conflict-resolution guidance\n\n...\n");
			setup(async () => [], client, new StubLlmProvider(), {
				installationId: 555,
				accountLogin: "acme-corp",
				accountType: "Organization",
				boundAt: "2026-06-30T00:00:00.000Z",
			});
			await new Promise((resolve) => server.once("listening", resolve));

			const { status, body } = await call(server, "POST", "/account/github/repos/setup", { owner: "acme-corp", name: "widgets" });

			expect(status).toBe(200);
			expect(body).toEqual({ status: "already-set-up" });
		});

		it("returns 400 for repo setup when no installation is bound", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
			setup();
			await new Promise((resolve) => server.once("listening", resolve));

			const { status, body } = await call(server, "POST", "/account/github/repos/setup", { owner: "acme-corp", name: "widgets" });

			expect(status).toBe(400);
			expect(body["error"]).toBe("Install the GitHub App first");
		});
	});

	describe("POST /repos/refresh", () => {
		it("is a no-op when no installation is bound", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
			setup();
			await new Promise((resolve) => server.once("listening", resolve));

			const { status, body } = await call(server, "POST", "/account/github/repos/refresh");

			expect(status).toBe(200);
			expect(body["refreshed"]).toBe(false);
		});

		it("re-fetches and re-ingests the already-selected repo's open PRs", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
			const client = new StubGitHubClient();
			client.addFixture("acme-corp", "widgets", makePrFixture({ owner: "acme-corp", repo: "widgets" }));
			const provider = new StubLlmProvider();
			provider.queueCompletion('["adds OTP login"]');
			provider.queueCompletion(JSON.stringify([{ clause: "adds OTP login", matchedDirection: true }]));
			const { state } = setup(async () => [], client, provider, {
				installationId: 555,
				accountLogin: "acme-corp",
				accountType: "Organization",
				boundAt: "2026-06-30T00:00:00.000Z",
				selectedRepo: { owner: "acme-corp", name: "widgets" },
			});
			await new Promise((resolve) => server.once("listening", resolve));

			const { status, body } = await call(server, "POST", "/account/github/repos/refresh");

			expect(status).toBe(200);
			expect(body["refreshed"]).toBe(true);
			expect(state.bundles.size).toBe(1);
		});
	});

	describe("POST /settings", () => {
		it("persists autoMergeOnAccept and surfaces it on status", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
			const { accountPath } = setup(async () => [], new StubGitHubClient(), new StubLlmProvider(), {
				installationId: 555,
				accountLogin: "acme-corp",
				accountType: "Organization",
				boundAt: "2026-06-30T00:00:00.000Z",
			});
			await new Promise((resolve) => server.once("listening", resolve));

			const { status, body } = await call(server, "POST", "/account/github/settings", { autoMergeOnAccept: true });

			expect(status).toBe(200);
			expect(body).toEqual({ autoMergeOnAccept: true });

			const persisted = JSON.parse(await readFile(accountPath, "utf8")) as Record<string, unknown>;
			expect(persisted["autoMergeOnAccept"]).toBe(true);
		});

		it.each<TeamRole>(["admin", "member"])("rejects %s with 403 — this toggle changes team-wide merge policy", async (role) => {
			dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
			setup(
				async () => [],
				new StubGitHubClient(),
				new StubLlmProvider(),
				{ installationId: 555, accountLogin: "acme-corp", accountType: "Organization", boundAt: "2026-06-30T00:00:00.000Z" },
				async () => ({ accountLogin: "acme-corp", accountType: "Organization" }),
				role,
			);
			await new Promise((resolve) => server.once("listening", resolve));

			const { status } = await call(server, "POST", "/account/github/settings", { autoMergeOnAccept: true });
			expect(status).toBe(403);
		});

		it("returns 400 when no installation is bound", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
			setup();
			await new Promise((resolve) => server.once("listening", resolve));

			const { status } = await call(server, "POST", "/account/github/settings", { autoMergeOnAccept: true });

			expect(status).toBe(400);
		});
	});

	it("disconnects, clearing the persisted binding", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
		const { accountPath } = setup(async () => [], new StubGitHubClient(), new StubLlmProvider(), {
			installationId: 555,
			accountLogin: "acme-corp",
			accountType: "Organization",
			boundAt: "2026-06-30T00:00:00.000Z",
		});
		await new Promise((resolve) => server.once("listening", resolve));

		const { status, body } = await call(server, "POST", "/account/github/disconnect");

		expect(status).toBe(200);
		expect(body).toEqual({ connected: false });
		await expect(readFile(accountPath, "utf8")).rejects.toThrow();
	});

	it("keeps the selected repo and auto-merge setting available on /status after disconnect", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
		setup(async () => [], new StubGitHubClient(), new StubLlmProvider(), {
			installationId: 555,
			accountLogin: "acme-corp",
			accountType: "Organization",
			boundAt: "2026-06-30T00:00:00.000Z",
			selectedRepo: { owner: "acme-corp", name: "widgets" },
			autoMergeOnAccept: true,
		});
		await new Promise((resolve) => server.once("listening", resolve));

		await call(server, "POST", "/account/github/disconnect");
		const { body } = await call(server, "GET", "/account/github/status");

		expect(body).toEqual({
			connected: false,
			selectedRepo: { owner: "acme-corp", name: "widgets" },
			autoMergeOnAccept: true,
		});
	});

	it("restores the previously selected repo and auto-merge setting when reconnecting after a disconnect", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
		const { accountPath } = setup(async () => [], new StubGitHubClient(), new StubLlmProvider(), {
			installationId: 555,
			accountLogin: "acme-corp",
			accountType: "Organization",
			boundAt: "2026-06-30T00:00:00.000Z",
			selectedRepo: { owner: "acme-corp", name: "widgets" },
			autoMergeOnAccept: true,
		});
		await new Promise((resolve) => server.once("listening", resolve));

		await call(server, "POST", "/account/github/disconnect");

		const start = await call(server, "POST", "/account/github/install/start");
		const state = new URL(start.body["installUrl"] as string).searchParams.get("state");
		const { status, location } = await callRedirect(
			server,
			`/account/github/install/callback?installation_id=555&state=${state}`,
			cookiePair(start.setCookie),
		);

		expect(status).toBe(302);
		expect(location).toBe("/?account=connected");

		const persisted = JSON.parse(await readFile(accountPath, "utf8")) as Record<string, unknown>;
		expect(persisted["selectedRepo"]).toEqual({ owner: "acme-corp", name: "widgets" });
		expect(persisted["autoMergeOnAccept"]).toBe(true);

		const { body } = await call(server, "GET", "/account/github/status");
		expect(body).toEqual(
			expect.objectContaining({
				connected: true,
				selectedRepo: { owner: "acme-corp", name: "widgets" },
				autoMergeOnAccept: true,
			}),
		);
	});
});
