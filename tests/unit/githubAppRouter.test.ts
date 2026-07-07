import { describe, it, expect, afterEach, jest } from "@jest/globals";
import type { Octokit } from "@octokit/rest";
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
import { WORKFLOW_CONTENT } from "../../src/engine/github/repoSetup.js";
import { StubStaticAnalyzer } from "../mocks/staticAnalyzer.js";
import type { InstallationAccountState, RepoBinding } from "../../src/engine/github/installation.js";
import type { PipelineConfig } from "../../src/engine/pipeline/pipeline.js";
import type { PipelineDeps } from "../../src/interface/server/ingestIntoQueue.js";
import type { RawPRPayload } from "../../src/engine/github/client.js";
import type { AccessibleInstallation, InstallationAccount } from "../../src/engine/github/installationClient.js";
import type { BuildOctokit } from "../../src/engine/github/collaborators.js";
import { RequestError } from "@octokit/request-error";
import { createUserTokenCache } from "../../src/engine/github/userTokenCache.js";
import type { UserTokenCache } from "../../src/engine/github/userTokenCache.js";
import { MergeQueue } from "../../src/engine/queue/mergeQueue.js";
import { LlmProviderHolder } from "../../src/engine/drift/effectList/providerHolder.js";
import { saveUserToken } from "../../src/engine/github/userToken.js";
import { OAuthExchangeError } from "../../src/engine/github/oauth.js";
import type { OAuthDeps } from "../../src/engine/github/oauth.js";

const PIPELINE_CONFIG: PipelineConfig = {
	gate: { criteria: [{ name: "buildFailure", mode: "enforce" }] },
	bundle: { similarityThreshold: 0.75 },
};

function repo(overrides: Partial<RepoSummary> & { fullName: string; installationId: number; accountLogin: string }): RepoSummary {
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

// Lets an unbind route's fire-and-forget revokeAccessOnUnbind chain (see githubApp.ts) settle
// before assertions run — the route responds before that chain resolves, same as team.ts's
// syncCollaboratorAdd/Remove (see teamRouter.test.ts's identical helper).
async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

function repoBindingFixture(overrides: Partial<RepoBinding> & { owner: string; name: string; installationId: number }): RepoBinding {
	return {
		addedAt: "2026-06-30T00:00:00.000Z",
		addedBy: "octocat",
		...overrides,
	};
}

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

// Deliberately not `@octokit/request-error`'s `RequestError`: in production, this error comes
// from a different, transitively-pinned copy of that package than any import here could resolve
// to, so `instanceof` can never be relied on. This fake only replicates the `name`/`status`
// shape the real error actually has, matching the duck-typed check `isInstallationRevoked` uses.
class FakeHttpError extends Error {
	readonly status: number;
	constructor(message: string, status: number) {
		super(message);
		this.name = "HttpError";
		this.status = status;
	}
}

describe("githubAppRouter", () => {
	let dir: string;
	let server: Server;

	afterEach(async () => {
		if (server) await new Promise((resolve) => server.close(resolve));
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	function setup(
		listRepos: (installationId: number, accountLogin: string) => Promise<ReadonlyArray<RepoSummary>> = async () => [],
		client: StubGitHubClient = new StubGitHubClient(),
		provider: StubLlmProvider = new StubLlmProvider(),
		initialState: InstallationAccountState | undefined = undefined,
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
		listInstallationsForUser: (accessToken: string) => Promise<ReadonlyArray<AccessibleInstallation>> = async () => [],
		isInstallationBoundToAnotherTeam: ((installationId: number) => boolean) | undefined = undefined,
		// Defaults to a no-op that always fails the exchange — fine for every test that never
		// persists a github-user-token.json in the first place (refreshUserTokenFromDisk is a
		// no-op with nothing on disk to load), and tests that DO care about the on-demand
		// refresh path pass their own.
		oauth: OAuthDeps = {
			config: { clientId: "client-id", clientSecret: "client-secret" },
			buildAuthorizeUrl: () => "https://github.com/login/oauth/authorize",
			exchangeCodeForToken: async () => ({ accessToken: "unused" }),
			refreshAccessToken: async () => {
				throw new OAuthExchangeError("no stored token expected in this test");
			},
			redirectUri: "http://localhost:3000/account/github/oauth/callback",
		},
		// Only exercised by tests that unbind a repo/installation while the team has members —
		// every other test's revokeAccessOnUnbind call short-circuits on an empty repo list
		// before this is ever invoked, so throwing by default catches an unintended real call.
		buildOctokit: BuildOctokit = () => {
			throw new Error("buildOctokit should not be called in this test");
		},
		listTeamMemberLogins: (forTeamId: string) => Promise<ReadonlyArray<string>> = async () => [],
		teamId = "test-team",
		// Trailing (rather than inserted alongside enrichWithUserToken above, which is where
		// githubAppRouter itself expects it) so every existing positional setup(...) call above
		// stays valid unchanged — only tests that care about filtering/access-checking need to
		// pass these.
		filterReposForUser: (repos: ReadonlyArray<RepoSummary>, accessToken: string) => Promise<ReadonlyArray<RepoSummary>> = async (
			repos,
		) => repos,
		canUserAccessRepo: (owner: string, name: string, accessToken: string) => Promise<boolean> = async () => true,
	): { accountPath: string; dataDir: string; state: ServerState; refreshDeps: RefreshDeps; userTokenCache: UserTokenCache } {
		const accountPath = join(dir, "installation.json");
		const holder = new GitHubClientHolder(client);
		const state = createServerState();
		const accountState = createAccountState(initialState);
		const decidedStore = new DecidedPrStore(join(dir, "decided-prs.json"));
		const userTokenCache = createUserTokenCache();
		const deps: PipelineDeps = {
			config: PIPELINE_CONFIG,
			provider,
			analyzer: new StubStaticAnalyzer(),
			auditStore: new AuditStore(),
			prCache: new PrEffectCache(),
		};
		const refreshDeps: RefreshDeps = {
			accountState,
			accountPath,
			clientHolder: holder,
			appConfig: { appId: "1", privateKey: "unused" },
			decidedStore,
			state,
			pipelineDeps: deps,
			queue: new MergeQueue(join(dir, "queue.json"), client, new LlmProviderHolder(new StubLlmProvider()), join(dir, "conflict.ndjson")),
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
			githubAppRouter({
				refreshDeps,
				appSlug: "quire-review",
				listInstallationRepos: listRepos,
				getInstallationAccount,
				secureCookies: false,
				userTokenCache,
				enrichWithUserToken,
				filterReposForUser,
				canUserAccessRepo,
				listInstallationsForUser,
				isInstallationBoundToAnotherTeam,
				dataDir: dir,
				oauth,
				buildOctokit,
				listTeamMemberLogins,
				teamId,
			}),
		);
		app.use(errorHandler);
		server = app.listen(0);
		return { accountPath, dataDir: dir, state, refreshDeps, userTokenCache };
	}

	it("reports not connected when no installation is bound", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
		setup();
		await new Promise((resolve) => server.once("listening", resolve));

		const { status, body } = await call(server, "GET", "/account/github/status");

		expect(status).toBe(200);
		expect(body).toEqual({
			connected: false,
			installations: [],
			repos: [],
		});
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
		setup(async () => []);
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
		setup(async () => []);
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

	it("binds the installation on a valid callback, persisting it", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
		const { accountPath } = setup(async () => []);
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

		const persisted = JSON.parse(await readFile(accountPath, "utf8")) as { installations: Record<string, unknown>[] };
		expect(persisted.installations).toHaveLength(1);
		expect(persisted.installations[0]?.["installationId"]).toBe(555);
		expect(persisted.installations[0]?.["accountLogin"]).toBe("acme-corp");

		const statusResult = await call(server, "GET", "/account/github/status");
		expect(statusResult.body["connected"]).toBe(true);
		expect(statusResult.body["installations"]).toEqual([
			expect.objectContaining({ installationId: 555, accountLogin: "acme-corp" }),
		]);
	});

	it("binding a second installation adds to, rather than replaces, the first", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
		const getInstallationAccount = jest
			.fn<(installationId: number) => Promise<InstallationAccount>>()
			.mockResolvedValueOnce({ accountLogin: "acme-corp", accountType: "Organization" })
			.mockResolvedValueOnce({ accountLogin: "octocat", accountType: "User" });
		const { accountPath } = setup(async () => [], new StubGitHubClient(), new StubLlmProvider(), undefined, getInstallationAccount);
		await new Promise((resolve) => server.once("listening", resolve));

		const firstStart = await call(server, "POST", "/account/github/install/start");
		const firstState = new URL(firstStart.body["installUrl"] as string).searchParams.get("state");
		await callRedirect(server, `/account/github/install/callback?installation_id=555&state=${firstState}`, cookiePair(firstStart.setCookie));

		const secondStart = await call(server, "POST", "/account/github/install/start");
		const secondState = new URL(secondStart.body["installUrl"] as string).searchParams.get("state");
		await callRedirect(server, `/account/github/install/callback?installation_id=777&state=${secondState}`, cookiePair(secondStart.setCookie));

		const persisted = JSON.parse(await readFile(accountPath, "utf8")) as { installations: Record<string, unknown>[] };
		expect(persisted.installations.map((i) => i["installationId"])).toEqual([555, 777]);
	});

	it("re-installing an already-bound installation upserts it instead of duplicating", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
		const getInstallationAccount = jest
			.fn<(installationId: number) => Promise<InstallationAccount>>()
			.mockResolvedValueOnce({ accountLogin: "acme-corp", accountType: "Organization" })
			.mockResolvedValueOnce({ accountLogin: "acme-corp-renamed", accountType: "Organization" });
		const { accountPath } = setup(async () => [], new StubGitHubClient(), new StubLlmProvider(), undefined, getInstallationAccount);
		await new Promise((resolve) => server.once("listening", resolve));

		const firstStart = await call(server, "POST", "/account/github/install/start");
		const firstState = new URL(firstStart.body["installUrl"] as string).searchParams.get("state");
		await callRedirect(server, `/account/github/install/callback?installation_id=555&state=${firstState}`, cookiePair(firstStart.setCookie));

		const secondStart = await call(server, "POST", "/account/github/install/start");
		const secondState = new URL(secondStart.body["installUrl"] as string).searchParams.get("state");
		await callRedirect(server, `/account/github/install/callback?installation_id=555&state=${secondState}`, cookiePair(secondStart.setCookie));

		const persisted = JSON.parse(await readFile(accountPath, "utf8")) as { installations: Record<string, unknown>[] };
		expect(persisted.installations).toHaveLength(1);
		expect(persisted.installations[0]?.["accountLogin"]).toBe("acme-corp-renamed");
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
			undefined,
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
		const { accountPath } = setup(async () => [], new StubGitHubClient(), new StubLlmProvider(), undefined, async () => ({
			accountLogin: "octocat",
			accountType: "User",
		}));
		await new Promise((resolve) => server.once("listening", resolve));
		const start = await call(server, "POST", "/account/github/install/start");
		const state = new URL(start.body["installUrl"] as string).searchParams.get("state");

		await callRedirect(server, `/account/github/install/callback?installation_id=777&state=${state}`, cookiePair(start.setCookie));

		const persisted = JSON.parse(await readFile(accountPath, "utf8")) as { installations: Record<string, unknown>[] };
		expect(persisted.installations[0]?.["accountLogin"]).toBe("octocat");
		expect(persisted.installations[0]?.["accountType"]).toBe("User");
	});

	it("redirects gracefully when the installation was revoked before the callback completes", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
		const revokedError = new FakeHttpError("Not Found", 404);
		const { accountPath } = setup(async () => [], new StubGitHubClient(), new StubLlmProvider(), undefined, async () => {
			throw revokedError;
		});
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
		const repos: ReadonlyArray<RepoSummary> = [repo({ fullName: "acme-corp/widgets", installationId: 555, accountLogin: "acme-corp" })];
		const listRepos = jest.fn(async (installationId: number) => {
			expect(installationId).toBe(555);
			return repos;
		});
		setup(listRepos, new StubGitHubClient(), new StubLlmProvider(), {
			installations: [{ installationId: 555, accountLogin: "acme-corp", accountType: "Organization", boundAt: "2026-06-30T00:00:00.000Z" }],
			repos: [],
		});
		await new Promise((resolve) => server.once("listening", resolve));

		const { status, body } = await call(server, "GET", "/account/github/repos");

		expect(status).toBe(200);
		expect(body["repos"]).toEqual(repos);
		expect(body["failedAccounts"]).toEqual([]);
		expect(listRepos).toHaveBeenCalledTimes(1);
	});

	it("merges repos across multiple bound installations", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
		const listRepos = jest.fn(async (installationId: number, accountLogin: string) => [
			repo({ fullName: `${accountLogin}/repo-${installationId}`, installationId, accountLogin }),
		]);
		setup(listRepos, new StubGitHubClient(), new StubLlmProvider(), {
			installations: [
				{ installationId: 555, accountLogin: "acme-corp", accountType: "Organization", boundAt: "2026-06-30T00:00:00.000Z" },
				{ installationId: 777, accountLogin: "octocat", accountType: "User", boundAt: "2026-06-30T00:00:00.000Z" },
			],
			repos: [],
		});
		await new Promise((resolve) => server.once("listening", resolve));

		const { status, body } = await call(server, "GET", "/account/github/repos");

		expect(status).toBe(200);
		expect((body["repos"] as RepoSummary[]).map((r) => r.fullName).sort()).toEqual(["acme-corp/repo-555", "octocat/repo-777"]);
		expect(body["failedAccounts"]).toEqual([]);
	});

	it("reports a failing installation in failedAccounts instead of breaking the whole picker", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
		const listRepos = jest.fn(async (installationId: number, accountLogin: string) => {
			if (installationId === 999) throw new Error("installation revoked");
			return [repo({ fullName: `${accountLogin}/widgets`, installationId, accountLogin })];
		});
		setup(listRepos, new StubGitHubClient(), new StubLlmProvider(), {
			installations: [
				{ installationId: 555, accountLogin: "acme-corp", accountType: "Organization", boundAt: "2026-06-30T00:00:00.000Z" },
				{ installationId: 999, accountLogin: "dead-org", accountType: "Organization", boundAt: "2026-06-30T00:00:00.000Z" },
			],
			repos: [],
		});
		await new Promise((resolve) => server.once("listening", resolve));

		const { status, body } = await call(server, "GET", "/account/github/repos");

		expect(status).toBe(200);
		expect(body["repos"]).toEqual([repo({ fullName: "acme-corp/widgets", installationId: 555, accountLogin: "acme-corp" })]);
		expect(body["failedAccounts"]).toEqual(["dead-org"]);
	});

	it("dedupes concurrent /repos calls against the same installation into a single upstream fetch", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
		let resolveFetch: (repos: ReadonlyArray<RepoSummary>) => void = () => undefined;
		const gate = new Promise<ReadonlyArray<RepoSummary>>((resolve) => {
			resolveFetch = resolve;
		});
		const listRepos = jest.fn(async () => gate);
		setup(listRepos, new StubGitHubClient(), new StubLlmProvider(), {
			installations: [{ installationId: 555, accountLogin: "acme-corp", accountType: "Organization", boundAt: "2026-06-30T00:00:00.000Z" }],
			repos: [],
		});
		await new Promise((resolve) => server.once("listening", resolve));

		const first = call(server, "GET", "/account/github/repos");
		const second = call(server, "GET", "/account/github/repos");
		resolveFetch([repo({ fullName: "acme-corp/widgets", installationId: 555, accountLogin: "acme-corp" })]);
		const [firstResult, secondResult] = await Promise.all([first, second]);

		expect(firstResult.status).toBe(200);
		expect(secondResult.status).toBe(200);
		expect(listRepos).toHaveBeenCalledTimes(1);
	});

	it("enriches with starred/pinned status when a user token is cached for the requester", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
		const repos: ReadonlyArray<RepoSummary> = [
			repo({ fullName: "acme-corp/widgets", installationId: 555, accountLogin: "acme-corp" }),
			repo({ fullName: "acme-corp/gadgets", installationId: 555, accountLogin: "acme-corp" }),
		];
		const enrichWithUserToken = jest.fn(async (input: ReadonlyArray<RepoSummary>, accessToken: string) =>
			input.map((r) => ({ ...r, starred: r.fullName === "acme-corp/gadgets" && accessToken === "user-token" })),
		);
		const { userTokenCache } = setup(
			async () => repos,
			new StubGitHubClient(),
			new StubLlmProvider(),
			{
				installations: [{ installationId: 555, accountLogin: "acme-corp", accountType: "Organization", boundAt: "2026-06-30T00:00:00.000Z" }],
				repos: [],
			},
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
			repo({ fullName: "acme-corp/widgets", installationId: 555, accountLogin: "acme-corp" }),
		];
		const enrichWithUserToken = jest.fn(async (input: ReadonlyArray<RepoSummary>) => input);
		setup(
			async () => repos,
			new StubGitHubClient(),
			new StubLlmProvider(),
			{
				installations: [{ installationId: 555, accountLogin: "acme-corp", accountType: "Organization", boundAt: "2026-06-30T00:00:00.000Z" }],
				repos: [],
			},
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

	it("reports sortingAvailable: false when no user token is cached (e.g. right after a redeploy)", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
		const repos: ReadonlyArray<RepoSummary> = [
			repo({ fullName: "acme-corp/widgets", installationId: 555, accountLogin: "acme-corp" }),
		];
		setup(
			async () => repos,
			new StubGitHubClient(),
			new StubLlmProvider(),
			{
				installations: [{ installationId: 555, accountLogin: "acme-corp", accountType: "Organization", boundAt: "2026-06-30T00:00:00.000Z" }],
				repos: [],
			},
			async () => ({ accountLogin: "acme-corp", accountType: "Organization" }),
			"owner",
			"octocat",
		);
		// Deliberately not calling userTokenCache.set — no cached token for "octocat".
		await new Promise((resolve) => server.once("listening", resolve));

		const { status, body } = await call(server, "GET", "/account/github/repos");

		expect(status).toBe(200);
		expect(body["sortingAvailable"]).toBe(false);
	});

	it("reports sortingAvailable: true when a user token is cached for the requester", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
		const repos: ReadonlyArray<RepoSummary> = [
			repo({ fullName: "acme-corp/widgets", installationId: 555, accountLogin: "acme-corp" }),
		];
		const { userTokenCache } = setup(
			async () => repos,
			new StubGitHubClient(),
			new StubLlmProvider(),
			{
				installations: [{ installationId: 555, accountLogin: "acme-corp", accountType: "Organization", boundAt: "2026-06-30T00:00:00.000Z" }],
				repos: [],
			},
			async () => ({ accountLogin: "acme-corp", accountType: "Organization" }),
			"owner",
			"octocat",
		);
		userTokenCache.set("octocat", { accessToken: "user-token", expiresAt: Date.now() + 60_000 });
		await new Promise((resolve) => server.once("listening", resolve));

		const { status, body } = await call(server, "GET", "/account/github/repos");

		expect(status).toBe(200);
		expect(body["sortingAvailable"]).toBe(true);
	});

	it("silently refreshes from a persisted refresh token when no access token is cached, restoring sortingAvailable", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
		const repos: ReadonlyArray<RepoSummary> = [
			repo({ fullName: "acme-corp/widgets", installationId: 555, accountLogin: "acme-corp" }),
		];
		const oauth: OAuthDeps = {
			config: { clientId: "client-id", clientSecret: "client-secret" },
			buildAuthorizeUrl: () => "https://github.com/login/oauth/authorize",
			exchangeCodeForToken: async () => ({ accessToken: "unused" }),
			refreshAccessToken: async (_config, refreshToken) => {
				expect(refreshToken).toBe("refresh-1");
				return { accessToken: "fresh-access-token" };
			},
			redirectUri: "http://localhost:3000/account/github/oauth/callback",
		};
		const { dataDir } = setup(
			async () => repos,
			new StubGitHubClient(),
			new StubLlmProvider(),
			{
				installations: [{ installationId: 555, accountLogin: "acme-corp", accountType: "Organization", boundAt: "2026-06-30T00:00:00.000Z" }],
				repos: [],
			},
			async () => ({ accountLogin: "acme-corp", accountType: "Organization" }),
			"owner",
			"octocat",
			async (repos) => repos,
			undefined,
			undefined,
			oauth,
		);
		await new Promise((resolve) => server.once("listening", resolve));
		await saveUserToken(join(dataDir, "users", "octocat", "github-user-token.json"), { refreshToken: "refresh-1" });

		const { status, body } = await call(server, "GET", "/account/github/repos");

		expect(status).toBe(200);
		expect(body["sortingAvailable"]).toBe(true);
	});

	it("filters the merged repo list down to what the requesting user can personally access", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
		const repos: ReadonlyArray<RepoSummary> = [
			repo({ fullName: "acme-corp/public-repo", installationId: 555, accountLogin: "acme-corp", private: false }),
			repo({ fullName: "acme-corp/shared-repo", installationId: 555, accountLogin: "acme-corp", private: true }),
			repo({ fullName: "acme-corp/secret-repo", installationId: 555, accountLogin: "acme-corp", private: true }),
		];
		// Stands in for filterReposAccessibleToUser: a real installation grant (e.g. from
		// another team member's own installation) can include private repos this particular
		// requester has no GitHub access to — only "shared-repo" is in their own accessible set.
		const filterReposForUser = jest.fn(async (input: ReadonlyArray<RepoSummary>) =>
			input.filter((r) => !r.private || r.fullName === "acme-corp/shared-repo"),
		);
		const { userTokenCache } = setup(
			async () => repos,
			new StubGitHubClient(),
			new StubLlmProvider(),
			{
				installations: [{ installationId: 555, accountLogin: "acme-corp", accountType: "Organization", boundAt: "2026-06-30T00:00:00.000Z" }],
				repos: [],
			},
			undefined,
			undefined,
			"octocat",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			filterReposForUser,
		);
		userTokenCache.set("octocat", { accessToken: "user-token", expiresAt: Date.now() + 60_000 });
		await new Promise((resolve) => server.once("listening", resolve));

		const { status, body } = await call(server, "GET", "/account/github/repos");

		expect(status).toBe(200);
		expect(filterReposForUser).toHaveBeenCalledTimes(1);
		expect((body["repos"] as RepoSummary[]).map((r) => r.fullName).sort()).toEqual([
			"acme-corp/public-repo",
			"acme-corp/shared-repo",
		]);
	});

	it("falls back to public-only when no user token can be resolved for the requester", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
		const repos: ReadonlyArray<RepoSummary> = [
			repo({ fullName: "acme-corp/public-repo", installationId: 555, accountLogin: "acme-corp", private: false }),
			repo({ fullName: "acme-corp/secret-repo", installationId: 555, accountLogin: "acme-corp", private: true }),
		];
		const filterReposForUser = jest.fn(async (input: ReadonlyArray<RepoSummary>) => input);
		setup(
			async () => repos,
			new StubGitHubClient(),
			new StubLlmProvider(),
			{
				installations: [{ installationId: 555, accountLogin: "acme-corp", accountType: "Organization", boundAt: "2026-06-30T00:00:00.000Z" }],
				repos: [],
			},
			undefined,
			undefined,
			"octocat",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			filterReposForUser,
		);
		// Deliberately not calling userTokenCache.set — no cached token for "octocat", so there's
		// no way to confirm anything beyond public visibility.
		await new Promise((resolve) => server.once("listening", resolve));

		const { status, body } = await call(server, "GET", "/account/github/repos");

		expect(status).toBe(200);
		expect(filterReposForUser).not.toHaveBeenCalled();
		expect(body["repos"]).toEqual([repos[0]]);
	});

	it("returns 400 for /repos when no installation is bound", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
		setup();
		await new Promise((resolve) => server.once("listening", resolve));

		const { status, body } = await call(server, "GET", "/account/github/repos");

		expect(status).toBe(400);
		expect(body["error"]).toBe("Install the GitHub App first");
	});

	describe("POST /repos/select", () => {
		it("adds a repo, persists it (with its owning installation), and ingests its open PRs", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
			const client = new StubGitHubClient();
			client.addFixture("acme-corp", "widgets", makePrFixture({ owner: "acme-corp", repo: "widgets" }));
			const provider = new StubLlmProvider();
			provider.queueCompletion('["adds OTP login"]');
			provider.queueCompletion(JSON.stringify([{ clause: "adds OTP login", matchedDirection: true }]));
			const { accountPath, state, userTokenCache } = setup(
				async () => [],
				client,
				provider,
				{
					installations: [{ installationId: 555, accountLogin: "acme-corp", accountType: "Organization", boundAt: "2026-06-30T00:00:00.000Z" }],
					repos: [],
				},
				undefined,
				undefined,
				"octocat",
			);
			userTokenCache.set("octocat", { accessToken: "user-token", expiresAt: Date.now() + 60_000 });
			await new Promise((resolve) => server.once("listening", resolve));

			const { status, body } = await call(server, "POST", "/account/github/repos/select", {
				owner: "acme-corp",
				name: "widgets",
				installationId: 555,
			});

			expect(status).toBe(200);
			expect(body["added"]).toEqual(
				expect.objectContaining({ owner: "acme-corp", name: "widgets", installationId: 555 }),
			);
			expect(body["bundlesCreated"]).toBe(1);
			expect(state.bundles.size).toBe(1);

			const persisted = JSON.parse(await readFile(accountPath, "utf8")) as { repos: Record<string, unknown>[] };
			expect(persisted.repos).toEqual([expect.objectContaining({ owner: "acme-corp", name: "widgets", installationId: 555 })]);
		});

		it("adds a second distinct repo alongside an already-watched one", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
			const client = new StubGitHubClient();
			const { accountPath, userTokenCache } = setup(
				async () => [],
				client,
				new StubLlmProvider(),
				{
					installations: [{ installationId: 555, accountLogin: "acme-corp", accountType: "Organization", boundAt: "2026-06-30T00:00:00.000Z" }],
					repos: [repoBindingFixture({ owner: "acme-corp", name: "widgets", installationId: 555 })],
				},
				undefined,
				undefined,
				"octocat",
			);
			userTokenCache.set("octocat", { accessToken: "user-token", expiresAt: Date.now() + 60_000 });
			await new Promise((resolve) => server.once("listening", resolve));

			const { status, body } = await call(server, "POST", "/account/github/repos/select", {
				owner: "acme-corp",
				name: "gadgets",
				installationId: 555,
			});

			expect(status).toBe(200);
			expect(body["added"]).toEqual(expect.objectContaining({ owner: "acme-corp", name: "gadgets" }));

			const persisted = JSON.parse(await readFile(accountPath, "utf8")) as { repos: Record<string, unknown>[] };
			expect(persisted.repos.map((r) => r["name"]).sort()).toEqual(["gadgets", "widgets"]);
		});

		it("409s when re-adding a repo that's already being watched", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
			setup(async () => [], new StubGitHubClient(), new StubLlmProvider(), {
				installations: [{ installationId: 555, accountLogin: "acme-corp", accountType: "Organization", boundAt: "2026-06-30T00:00:00.000Z" }],
				repos: [repoBindingFixture({ owner: "acme-corp", name: "widgets", installationId: 555 })],
			});
			await new Promise((resolve) => server.once("listening", resolve));

			const { status, body } = await call(server, "POST", "/account/github/repos/select", {
				owner: "acme-corp",
				name: "widgets",
				installationId: 555,
			});

			expect(status).toBe(409);
			expect(body["error"]).toBe("This repo is already being watched");
		});

		it("403s when the requesting user has no personal GitHub access to the repo, without mutating state", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
			const canUserAccessRepo = jest.fn(async () => false);
			const { refreshDeps, userTokenCache } = setup(
				async () => [],
				new StubGitHubClient(),
				new StubLlmProvider(),
				{
					installations: [{ installationId: 555, accountLogin: "acme-corp", accountType: "Organization", boundAt: "2026-06-30T00:00:00.000Z" }],
					repos: [],
				},
				undefined,
				undefined,
				"octocat",
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				canUserAccessRepo,
			);
			userTokenCache.set("octocat", { accessToken: "user-token", expiresAt: Date.now() + 60_000 });
			await new Promise((resolve) => server.once("listening", resolve));

			const { status, body } = await call(server, "POST", "/account/github/repos/select", {
				owner: "acme-corp",
				name: "widgets",
				installationId: 555,
			});

			expect(status).toBe(403);
			expect(body["error"]).toBe("You don't have access to this repository");
			expect(canUserAccessRepo).toHaveBeenCalledWith("acme-corp", "widgets", "user-token");
			expect(refreshDeps.accountState.current.repos).toEqual([]);
		});

		it("403s when no user token can be resolved for the requester, without mutating state", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
			const { refreshDeps } = setup(async () => [], new StubGitHubClient(), new StubLlmProvider(), {
				installations: [{ installationId: 555, accountLogin: "acme-corp", accountType: "Organization", boundAt: "2026-06-30T00:00:00.000Z" }],
				repos: [],
			});
			// Deliberately no loginForRequests/userTokenCache setup — nothing to verify access with.
			await new Promise((resolve) => server.once("listening", resolve));

			const { status, body } = await call(server, "POST", "/account/github/repos/select", {
				owner: "acme-corp",
				name: "widgets",
				installationId: 555,
			});

			expect(status).toBe(403);
			expect(body["error"]).toBe("You don't have access to this repository");
			expect(refreshDeps.accountState.current.repos).toEqual([]);
		});

		it("rejects repo selection against an installation that isn't bound", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
			setup(async () => [], new StubGitHubClient(), new StubLlmProvider(), {
				installations: [{ installationId: 555, accountLogin: "acme-corp", accountType: "Organization", boundAt: "2026-06-30T00:00:00.000Z" }],
				repos: [],
			});
			await new Promise((resolve) => server.once("listening", resolve));

			const { status, body } = await call(server, "POST", "/account/github/repos/select", {
				owner: "acme-corp",
				name: "widgets",
				installationId: 999,
			});

			expect(status).toBe(400);
			expect(body["error"]).toBe("Unknown installation");
		});

		it("rejects repo selection when no installation is bound", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
			setup();
			await new Promise((resolve) => server.once("listening", resolve));

			const { status, body } = await call(server, "POST", "/account/github/repos/select", {
				owner: "acme-corp",
				name: "widgets",
				installationId: 555,
			});

			expect(status).toBe(400);
			expect(body["error"]).toBe("Unknown installation");
		});

		it("rolls back the just-added repo (without touching any other watched repo) when its initial ingest fails", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
			const workingClient = new StubGitHubClient();
			workingClient.addFixture("acme-corp", "widgets", makePrFixture({ owner: "acme-corp", repo: "widgets" }));
			// Fails only for the specific repo being added, mirroring the old
			// buildClient-per-installation failure injection now that there's a single shared
			// client resolving every repo — the failure is keyed on (owner, name) instead.
			class PartiallyFailingClient extends StubGitHubClient {
				override async listOpenPullRequests(owner: string, repo: string) {
					if (owner === "octocat" && repo === "broken-repo") throw new Error("GitHub API unavailable");
					return super.listOpenPullRequests(owner, repo);
				}
			}
			const client = new PartiallyFailingClient();
			client.addFixture("acme-corp", "widgets", makePrFixture({ owner: "acme-corp", repo: "widgets" }));
			const provider = new StubLlmProvider();
			provider.queueCompletion('["adds OTP login"]');
			provider.queueCompletion(JSON.stringify([{ clause: "adds OTP login", matchedDirection: true }]));
			const { state, refreshDeps, userTokenCache } = setup(
				async () => [],
				client,
				provider,
				{
					installations: [
						{ installationId: 555, accountLogin: "acme-corp", accountType: "Organization", boundAt: "2026-06-30T00:00:00.000Z" },
						{ installationId: 777, accountLogin: "octocat", accountType: "User", boundAt: "2026-06-30T00:00:00.000Z" },
					],
					repos: [],
				},
				undefined,
				undefined,
				"octocat",
			);
			userTokenCache.set("octocat", { accessToken: "user-token", expiresAt: Date.now() + 60_000 });
			await new Promise((resolve) => server.once("listening", resolve));

			const first = await call(server, "POST", "/account/github/repos/select", { owner: "acme-corp", name: "widgets", installationId: 555 });
			expect(first.status).toBe(200);
			expect(state.bundles.size).toBe(1);

			const second = await call(server, "POST", "/account/github/repos/select", { owner: "octocat", name: "broken-repo", installationId: 777 });

			expect(second.status).toBeGreaterThanOrEqual(400);
			// The failed add must not stick around in repos[], nor lose the previously-added
			// repo's already-ingested bundles.
			expect(refreshDeps.accountState.current.repos).toEqual([
				expect.objectContaining({ owner: "acme-corp", name: "widgets", installationId: 555 }),
			]);
			expect(state.bundles.size).toBe(1);
		});
	});

	describe("DELETE /repos/:owner/:name", () => {
		it("removes exactly the named repo, leaving other watched repos untouched", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
			const { accountPath, refreshDeps } = setup(async () => [], new StubGitHubClient(), new StubLlmProvider(), {
				installations: [{ installationId: 555, accountLogin: "acme-corp", accountType: "Organization", boundAt: "2026-06-30T00:00:00.000Z" }],
				repos: [
					repoBindingFixture({ owner: "acme-corp", name: "widgets", installationId: 555 }),
					repoBindingFixture({ owner: "acme-corp", name: "gadgets", installationId: 555 }),
				],
			});
			await new Promise((resolve) => server.once("listening", resolve));

			const { status, body } = await call(server, "DELETE", "/account/github/repos/acme-corp/widgets");

			expect(status).toBe(200);
			expect(body).toEqual({ removed: true });
			expect(refreshDeps.accountState.current.repos).toEqual([
				expect.objectContaining({ owner: "acme-corp", name: "gadgets" }),
			]);

			const persisted = JSON.parse(await readFile(accountPath, "utf8")) as { repos: Record<string, unknown>[] };
			expect(persisted.repos).toHaveLength(1);
			expect(persisted.repos[0]?.["name"]).toBe("gadgets");
		});

		it("404s for a repo that isn't currently watched", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
			setup(async () => [], new StubGitHubClient(), new StubLlmProvider(), {
				installations: [{ installationId: 555, accountLogin: "acme-corp", accountType: "Organization", boundAt: "2026-06-30T00:00:00.000Z" }],
				repos: [],
			});
			await new Promise((resolve) => server.once("listening", resolve));

			const { status, body } = await call(server, "DELETE", "/account/github/repos/acme-corp/widgets");

			expect(status).toBe(404);
			expect(body["error"]).toBe("That repo isn't currently added");
		});

		it("revokes every current team member's GitHub collaborator access on the unbound repo", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
			const removeCollaborator = jest.fn(async () => undefined);
			const buildOctokit = jest.fn(() => ({ rest: { repos: { removeCollaborator } } }) as unknown as Octokit);
			const listTeamMemberLogins = jest.fn(async () => ["alice", "bob"]);
			setup(
				async () => [],
				new StubGitHubClient(),
				new StubLlmProvider(),
				{
					installations: [{ installationId: 555, accountLogin: "acme-corp", accountType: "Organization", boundAt: "2026-06-30T00:00:00.000Z" }],
					repos: [
						repoBindingFixture({ owner: "acme-corp", name: "widgets", installationId: 555 }),
						repoBindingFixture({ owner: "acme-corp", name: "gadgets", installationId: 555 }),
					],
				},
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				buildOctokit,
				listTeamMemberLogins,
			);
			await new Promise((resolve) => server.once("listening", resolve));

			const { status } = await call(server, "DELETE", "/account/github/repos/acme-corp/widgets");
			expect(status).toBe(200);

			await waitFor(() => removeCollaborator.mock.calls.length > 0);
			// Only the unbound repo (widgets), not the one still watched (gadgets).
			expect(removeCollaborator).toHaveBeenCalledWith({ owner: "acme-corp", repo: "widgets", username: "alice" });
			expect(removeCollaborator).toHaveBeenCalledWith({ owner: "acme-corp", repo: "widgets", username: "bob" });
			expect(removeCollaborator).toHaveBeenCalledTimes(2);
		});
	});

	describe("POST /repos/setup", () => {
		it("opens a setup PR documenting and enforcing the declared-direction convention", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
			const client = new StubGitHubClient();
			setup(async () => [], client, new StubLlmProvider(), {
				installations: [{ installationId: 555, accountLogin: "acme-corp", accountType: "Organization", boundAt: "2026-06-30T00:00:00.000Z" }],
				repos: [],
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
			setup(async () => [], client, new StubLlmProvider(), {
				installations: [{ installationId: 555, accountLogin: "acme-corp", accountType: "Organization", boundAt: "2026-06-30T00:00:00.000Z" }],
				repos: [],
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

	describe("POST /repos/setup-status", () => {
		it("reports alreadySetUp: true without touching the repo when the conventions are already in place", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
			const client = new StubGitHubClient();
			client.seedFile(
				"acme-corp",
				"widgets",
				".github/pull_request_template.md",
				"## Declared direction\n\n<!-- declared-direction: ... -->\n",
			);
			client.seedFile("acme-corp", "widgets", ".github/workflows/quire-declared-direction.yml", WORKFLOW_CONTENT);
			setup(async () => [], client, new StubLlmProvider(), {
				installations: [{ installationId: 555, accountLogin: "acme-corp", accountType: "Organization", boundAt: "2026-06-30T00:00:00.000Z" }],
				repos: [],
			});
			await new Promise((resolve) => server.once("listening", resolve));

			const { status, body } = await call(server, "POST", "/account/github/repos/setup-status", { owner: "acme-corp", name: "widgets" });

			expect(status).toBe(200);
			expect(body).toEqual({ alreadySetUp: true });
		});

		it("reports alreadySetUp: false when the conventions are missing", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
			const client = new StubGitHubClient();
			setup(async () => [], client, new StubLlmProvider(), {
				installations: [{ installationId: 555, accountLogin: "acme-corp", accountType: "Organization", boundAt: "2026-06-30T00:00:00.000Z" }],
				repos: [],
			});
			await new Promise((resolve) => server.once("listening", resolve));

			const { status, body } = await call(server, "POST", "/account/github/repos/setup-status", { owner: "acme-corp", name: "widgets" });

			expect(status).toBe(200);
			expect(body).toEqual({ alreadySetUp: false });
		});

		it("returns 400 for setup-status when no installation is bound", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
			setup();
			await new Promise((resolve) => server.once("listening", resolve));

			const { status, body } = await call(server, "POST", "/account/github/repos/setup-status", { owner: "acme-corp", name: "widgets" });

			expect(status).toBe(400);
			expect(body["error"]).toBe("Install the GitHub App first");
		});
	});

	describe("POST /repos/refresh", () => {
		it("reports refreshed: false when no repos are watched", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
			setup();
			await new Promise((resolve) => server.once("listening", resolve));

			const { status, body } = await call(server, "POST", "/account/github/repos/refresh");

			expect(status).toBe(200);
			expect(body["refreshed"]).toBe(false);
		});

		it("with no body, re-fetches and re-ingests every watched repo", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
			const client = new StubGitHubClient();
			client.addFixture("acme-corp", "widgets", makePrFixture({ owner: "acme-corp", repo: "widgets" }));
			client.addFixture("acme-corp", "gadgets", makePrFixture({ id: "pr-2", owner: "acme-corp", repo: "gadgets" }));
			const provider = new StubLlmProvider();
			provider.queueCompletion('["adds OTP login"]');
			provider.queueCompletion(JSON.stringify([{ clause: "adds OTP login", matchedDirection: true }]));
			provider.queueCompletion('["adds OTP login"]');
			provider.queueCompletion(JSON.stringify([{ clause: "adds OTP login", matchedDirection: true }]));
			const { state } = setup(async () => [], client, provider, {
				installations: [{ installationId: 555, accountLogin: "acme-corp", accountType: "Organization", boundAt: "2026-06-30T00:00:00.000Z" }],
				repos: [
					repoBindingFixture({ owner: "acme-corp", name: "widgets", installationId: 555 }),
					repoBindingFixture({ owner: "acme-corp", name: "gadgets", installationId: 555 }),
				],
			});
			await new Promise((resolve) => server.once("listening", resolve));

			const { status, body } = await call(server, "POST", "/account/github/repos/refresh");

			expect(status).toBe(200);
			expect(body["refreshed"]).toBe(true);
			expect(body["repos"]).toEqual(
				expect.arrayContaining([
					{ owner: "acme-corp", name: "widgets", ok: true },
					{ owner: "acme-corp", name: "gadgets", ok: true },
				]),
			);
			expect(state.bundles.size).toBe(2);
		});

		it("with a body, refreshes just the named repo", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
			const client = new StubGitHubClient();
			client.addFixture("acme-corp", "widgets", makePrFixture({ owner: "acme-corp", repo: "widgets" }));
			const provider = new StubLlmProvider();
			provider.queueCompletion('["adds OTP login"]');
			provider.queueCompletion(JSON.stringify([{ clause: "adds OTP login", matchedDirection: true }]));
			const { state } = setup(async () => [], client, provider, {
				installations: [{ installationId: 555, accountLogin: "acme-corp", accountType: "Organization", boundAt: "2026-06-30T00:00:00.000Z" }],
				repos: [
					repoBindingFixture({ owner: "acme-corp", name: "widgets", installationId: 555 }),
					repoBindingFixture({ owner: "acme-corp", name: "gadgets", installationId: 555 }),
				],
			});
			await new Promise((resolve) => server.once("listening", resolve));

			const { status, body } = await call(server, "POST", "/account/github/repos/refresh", { owner: "acme-corp", name: "widgets" });

			expect(status).toBe(200);
			expect(body["refreshed"]).toBe(true);
			expect(body["repos"]).toEqual([{ owner: "acme-corp", name: "widgets", ok: true }]);
			expect(state.bundles.size).toBe(1);
		});

		it("reports refreshed: false when the named repo in the body isn't watched", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
			setup(async () => [], new StubGitHubClient(), new StubLlmProvider(), {
				installations: [{ installationId: 555, accountLogin: "acme-corp", accountType: "Organization", boundAt: "2026-06-30T00:00:00.000Z" }],
				repos: [repoBindingFixture({ owner: "acme-corp", name: "widgets", installationId: 555 })],
			});
			await new Promise((resolve) => server.once("listening", resolve));

			const { status, body } = await call(server, "POST", "/account/github/repos/refresh", { owner: "acme-corp", name: "unwatched" });

			expect(status).toBe(200);
			expect(body["refreshed"]).toBe(false);
		});

		it("settles each repo independently — one failing repo doesn't sink the others", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
			class PartiallyFailingClient extends StubGitHubClient {
				override async listOpenPullRequests(owner: string, repo: string) {
					if (owner === "acme-corp" && repo === "gadgets") throw new Error("GitHub API unavailable");
					return super.listOpenPullRequests(owner, repo);
				}
			}
			const client = new PartiallyFailingClient();
			client.addFixture("acme-corp", "widgets", makePrFixture({ owner: "acme-corp", repo: "widgets" }));
			const provider = new StubLlmProvider();
			provider.queueCompletion('["adds OTP login"]');
			provider.queueCompletion(JSON.stringify([{ clause: "adds OTP login", matchedDirection: true }]));
			setup(async () => [], client, provider, {
				installations: [{ installationId: 555, accountLogin: "acme-corp", accountType: "Organization", boundAt: "2026-06-30T00:00:00.000Z" }],
				repos: [
					repoBindingFixture({ owner: "acme-corp", name: "widgets", installationId: 555 }),
					repoBindingFixture({ owner: "acme-corp", name: "gadgets", installationId: 555 }),
				],
			});
			await new Promise((resolve) => server.once("listening", resolve));

			const { status, body } = await call(server, "POST", "/account/github/repos/refresh");

			expect(status).toBe(200);
			expect(body["refreshed"]).toBe(true);
			expect(body["repos"]).toEqual(
				expect.arrayContaining([
					{ owner: "acme-corp", name: "widgets", ok: true },
					{ owner: "acme-corp", name: "gadgets", ok: false },
				]),
			);
		});
	});

	describe("POST /repos/:owner/:name/settings", () => {
		it("persists per-repo settings and returns the updated RepoBinding", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
			const { accountPath } = setup(async () => [], new StubGitHubClient(), new StubLlmProvider(), {
				installations: [{ installationId: 555, accountLogin: "acme-corp", accountType: "Organization", boundAt: "2026-06-30T00:00:00.000Z" }],
				repos: [repoBindingFixture({ owner: "acme-corp", name: "widgets", installationId: 555 })],
			});
			await new Promise((resolve) => server.once("listening", resolve));

			const { status, body } = await call(server, "POST", "/account/github/repos/acme-corp/widgets/settings", {
				autoMergeOnAccept: true,
				flagConflictsForFleet: false,
				enableDeepConflictInvestigation: false,
			});

			expect(status).toBe(200);
			expect(body).toEqual(
				expect.objectContaining({
					owner: "acme-corp",
					name: "widgets",
					installationId: 555,
					autoMergeOnAccept: true,
					flagConflictsForFleet: false,
					enableDeepConflictInvestigation: false,
				}),
			);

			const persisted = JSON.parse(await readFile(accountPath, "utf8")) as { repos: Record<string, unknown>[] };
			expect(persisted.repos[0]?.["autoMergeOnAccept"]).toBe(true);
		});

		it("does not affect another watched repo's settings", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
			const { refreshDeps } = setup(async () => [], new StubGitHubClient(), new StubLlmProvider(), {
				installations: [{ installationId: 555, accountLogin: "acme-corp", accountType: "Organization", boundAt: "2026-06-30T00:00:00.000Z" }],
				repos: [
					repoBindingFixture({ owner: "acme-corp", name: "widgets", installationId: 555 }),
					repoBindingFixture({ owner: "acme-corp", name: "gadgets", installationId: 555 }),
				],
			});
			await new Promise((resolve) => server.once("listening", resolve));

			await call(server, "POST", "/account/github/repos/acme-corp/widgets/settings", {
				autoMergeOnAccept: true,
				flagConflictsForFleet: false,
				enableDeepConflictInvestigation: false,
			});

			const gadgets = refreshDeps.accountState.current.repos.find((r) => r.name === "gadgets");
			expect(gadgets?.autoMergeOnAccept).toBeUndefined();
		});

		it("404s for a repo that isn't currently added", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
			setup(async () => [], new StubGitHubClient(), new StubLlmProvider(), {
				installations: [{ installationId: 555, accountLogin: "acme-corp", accountType: "Organization", boundAt: "2026-06-30T00:00:00.000Z" }],
				repos: [],
			});
			await new Promise((resolve) => server.once("listening", resolve));

			const { status, body } = await call(server, "POST", "/account/github/repos/acme-corp/widgets/settings", {
				autoMergeOnAccept: true,
				flagConflictsForFleet: false,
				enableDeepConflictInvestigation: false,
			});

			expect(status).toBe(404);
			expect(body["error"]).toBe("That repo isn't currently added");
		});

		it.each<TeamRole>(["admin", "member"])("rejects %s with 403 — this toggle changes merge policy for the repo", async (role) => {
			dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
			setup(
				async () => [],
				new StubGitHubClient(),
				new StubLlmProvider(),
				{
					installations: [{ installationId: 555, accountLogin: "acme-corp", accountType: "Organization", boundAt: "2026-06-30T00:00:00.000Z" }],
					repos: [repoBindingFixture({ owner: "acme-corp", name: "widgets", installationId: 555 })],
				},
				async () => ({ accountLogin: "acme-corp", accountType: "Organization" }),
				role,
			);
			await new Promise((resolve) => server.once("listening", resolve));

			const { status } = await call(server, "POST", "/account/github/repos/acme-corp/widgets/settings", {
				autoMergeOnAccept: true,
				flagConflictsForFleet: false,
				enableDeepConflictInvestigation: false,
			});
			expect(status).toBe(403);
		});
	});

	describe("POST /disconnect/:installationId", () => {
		it("disconnects a single installation, leaving other installations and their repos untouched", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
			const { accountPath } = setup(async () => [], new StubGitHubClient(), new StubLlmProvider(), {
				installations: [
					{ installationId: 555, accountLogin: "acme-corp", accountType: "Organization", boundAt: "2026-06-30T00:00:00.000Z" },
					{ installationId: 777, accountLogin: "octocat", accountType: "User", boundAt: "2026-06-30T00:00:00.000Z" },
				],
				repos: [repoBindingFixture({ owner: "octocat", name: "widgets", installationId: 777 })],
			});
			await new Promise((resolve) => server.once("listening", resolve));

			const { status, body } = await call(server, "POST", "/account/github/disconnect/555");

			expect(status).toBe(200);
			expect(body).toEqual({ disconnected: 555, remaining: 1, reposRemoved: 0 });

			const persisted = JSON.parse(await readFile(accountPath, "utf8")) as { installations: unknown[]; repos: Record<string, unknown>[] };
			expect(persisted.installations).toHaveLength(1);
			expect(persisted.repos).toEqual([expect.objectContaining({ owner: "octocat", name: "widgets" })]);
		});

		it("orphans every repo bound through the disconnected installation, reporting the count", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
			const { accountPath, refreshDeps } = setup(async () => [], new StubGitHubClient(), new StubLlmProvider(), {
				installations: [
					{ installationId: 555, accountLogin: "acme-corp", accountType: "Organization", boundAt: "2026-06-30T00:00:00.000Z" },
					{ installationId: 777, accountLogin: "octocat", accountType: "User", boundAt: "2026-06-30T00:00:00.000Z" },
				],
				repos: [
					repoBindingFixture({ owner: "acme-corp", name: "widgets", installationId: 555 }),
					repoBindingFixture({ owner: "acme-corp", name: "gadgets", installationId: 555 }),
					repoBindingFixture({ owner: "octocat", name: "other-repo", installationId: 777 }),
				],
			});
			await new Promise((resolve) => server.once("listening", resolve));

			const { status, body } = await call(server, "POST", "/account/github/disconnect/555");

			expect(status).toBe(200);
			expect(body).toEqual({ disconnected: 555, remaining: 1, reposRemoved: 2 });
			expect(refreshDeps.accountState.current.repos).toEqual([
				expect.objectContaining({ owner: "octocat", name: "other-repo" }),
			]);

			const persisted = JSON.parse(await readFile(accountPath, "utf8")) as { repos: Record<string, unknown>[] };
			expect(persisted.repos).toHaveLength(1);
		});

		it("disconnecting the last installation clears every watched repo and tears down the persisted file", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
			const { accountPath } = setup(async () => [], new StubGitHubClient(), new StubLlmProvider(), {
				installations: [{ installationId: 555, accountLogin: "acme-corp", accountType: "Organization", boundAt: "2026-06-30T00:00:00.000Z" }],
				repos: [repoBindingFixture({ owner: "acme-corp", name: "widgets", installationId: 555 })],
			});
			await new Promise((resolve) => server.once("listening", resolve));

			const { status, body } = await call(server, "POST", "/account/github/disconnect/555");

			expect(status).toBe(200);
			expect(body).toEqual({ disconnected: 555, remaining: 0, reposRemoved: 1 });
			// Disconnecting the last installation tears down the file the same way disconnect-all
			// does, rather than leaving a near-empty `{"installations":[],"repos":[]}` behind.
			await expect(readFile(accountPath, "utf8")).rejects.toThrow();

			const { body: statusBody } = await call(server, "GET", "/account/github/status");
			expect(statusBody).toEqual({ connected: false, installations: [], repos: [] });
		});

		it("rejects a non-numeric installation id on disconnect", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
			const { refreshDeps } = setup(async () => [], new StubGitHubClient(), new StubLlmProvider(), {
				installations: [{ installationId: 555, accountLogin: "acme-corp", accountType: "Organization", boundAt: "2026-06-30T00:00:00.000Z" }],
				repos: [],
			});
			await new Promise((resolve) => server.once("listening", resolve));

			const { status, body } = await call(server, "POST", "/account/github/disconnect/not-a-number");

			expect(status).toBe(400);
			expect(body["error"]).toBe("Invalid installation id");
			expect(refreshDeps.accountState.current.installations).toHaveLength(1);
		});

		it("rejects a negative installation id on disconnect", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
			setup(async () => [], new StubGitHubClient(), new StubLlmProvider(), {
				installations: [{ installationId: 555, accountLogin: "acme-corp", accountType: "Organization", boundAt: "2026-06-30T00:00:00.000Z" }],
				repos: [],
			});
			await new Promise((resolve) => server.once("listening", resolve));

			const { status, body } = await call(server, "POST", "/account/github/disconnect/-1");

			expect(status).toBe(400);
			expect(body["error"]).toBe("Invalid installation id");
		});
	});

	describe("POST /disconnect-all", () => {
		it("wipes every installation, every watched repo, and the persisted file", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
			const { accountPath } = setup(async () => [], new StubGitHubClient(), new StubLlmProvider(), {
				installations: [
					{ installationId: 555, accountLogin: "acme-corp", accountType: "Organization", boundAt: "2026-06-30T00:00:00.000Z" },
					{ installationId: 777, accountLogin: "octocat", accountType: "User", boundAt: "2026-06-30T00:00:00.000Z" },
				],
				repos: [
					repoBindingFixture({ owner: "acme-corp", name: "widgets", installationId: 555 }),
					repoBindingFixture({ owner: "octocat", name: "other-repo", installationId: 777 }),
				],
			});
			await new Promise((resolve) => server.once("listening", resolve));

			const { status, body } = await call(server, "POST", "/account/github/disconnect-all");

			expect(status).toBe(200);
			expect(body).toEqual({ connected: false });
			await expect(readFile(accountPath, "utf8")).rejects.toThrow();
		});

		it("clears every watched repo, visible via GET /status", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
			setup(async () => [], new StubGitHubClient(), new StubLlmProvider(), {
				installations: [{ installationId: 555, accountLogin: "acme-corp", accountType: "Organization", boundAt: "2026-06-30T00:00:00.000Z" }],
				repos: [repoBindingFixture({ owner: "acme-corp", name: "widgets", installationId: 555 })],
			});
			await new Promise((resolve) => server.once("listening", resolve));

			await call(server, "POST", "/account/github/disconnect-all");
			const { body } = await call(server, "GET", "/account/github/status");

			expect(body).toEqual({ connected: false, installations: [], repos: [] });
		});

		it("does not resurrect cleared repos when reconnecting after disconnect-all", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
			const { accountPath } = setup(async () => [], new StubGitHubClient(), new StubLlmProvider(), {
				installations: [{ installationId: 555, accountLogin: "acme-corp", accountType: "Organization", boundAt: "2026-06-30T00:00:00.000Z" }],
				repos: [repoBindingFixture({ owner: "acme-corp", name: "widgets", installationId: 555 })],
			});
			await new Promise((resolve) => server.once("listening", resolve));

			await call(server, "POST", "/account/github/disconnect-all");

			const start = await call(server, "POST", "/account/github/install/start");
			const state = new URL(start.body["installUrl"] as string).searchParams.get("state");
			const { status, location } = await callRedirect(
				server,
				`/account/github/install/callback?installation_id=555&state=${state}`,
				cookiePair(start.setCookie),
			);

			expect(status).toBe(302);
			expect(location).toBe("/?account=connected");

			// Disconnect-all already wiped repos (see the test above) — re-binding the same
			// installationId doesn't backfill them from anywhere, since there's no separate
			// preferences store to restore watched repos from in this model.
			const persisted = JSON.parse(await readFile(accountPath, "utf8")) as Record<string, unknown>;
			expect(persisted["repos"]).toEqual([]);

			const { body } = await call(server, "GET", "/account/github/status");
			expect(body).toEqual(expect.objectContaining({ connected: true, repos: [] }));
		});
	});

	describe("GET /repos", () => {
		it("returns the full watched-repos array as `selected`", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
			setup(async () => [], new StubGitHubClient(), new StubLlmProvider(), {
				installations: [{ installationId: 555, accountLogin: "acme-corp", accountType: "Organization", boundAt: "2026-06-30T00:00:00.000Z" }],
				repos: [
					repoBindingFixture({ owner: "acme-corp", name: "widgets", installationId: 555 }),
					repoBindingFixture({ owner: "acme-corp", name: "gadgets", installationId: 555 }),
				],
			});
			await new Promise((resolve) => server.once("listening", resolve));

			const { status, body } = await call(server, "GET", "/account/github/repos");

			expect(status).toBe(200);
			expect((body["selected"] as RepoBinding[]).map((r) => r.name).sort()).toEqual(["gadgets", "widgets"]);
		});
	});

	describe("GET /available-installations", () => {
		it("reports needsReconnect when no user token is cached for the requester", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
			setup(async () => [], new StubGitHubClient(), new StubLlmProvider(), undefined, undefined, undefined, "octocat");
			await new Promise((resolve) => server.once("listening", resolve));

			const { status, body } = await call(server, "GET", "/account/github/available-installations");

			expect(status).toBe(200);
			expect(body).toEqual({ installations: [], needsReconnect: true });
		});

		it("lists installations the signed-in user can access but hasn't bound yet", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
			const accessible: ReadonlyArray<AccessibleInstallation> = [
				{ installationId: 555, accountLogin: "acme-corp", accountType: "Organization" },
			];
			const { userTokenCache } = setup(
				async () => [],
				new StubGitHubClient(),
				new StubLlmProvider(),
				undefined,
				undefined,
				undefined,
				"octocat",
				undefined,
				async () => accessible,
			);
			userTokenCache.set("octocat", { accessToken: "user-token", expiresAt: Date.now() + 60_000 });
			await new Promise((resolve) => server.once("listening", resolve));

			const { status, body } = await call(server, "GET", "/account/github/available-installations");

			expect(status).toBe(200);
			expect(body).toEqual({ installations: accessible, needsReconnect: false });
		});

		it("excludes installations that are already bound to this tenant", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
			const accessible: ReadonlyArray<AccessibleInstallation> = [
				{ installationId: 555, accountLogin: "acme-corp", accountType: "Organization" },
				{ installationId: 777, accountLogin: "octocat", accountType: "User" },
			];
			const { userTokenCache } = setup(
				async () => [],
				new StubGitHubClient(),
				new StubLlmProvider(),
				{
					installations: [{ installationId: 555, accountLogin: "acme-corp", accountType: "Organization", boundAt: "2026-06-30T00:00:00.000Z" }],
					repos: [],
				},
				undefined,
				undefined,
				"octocat",
				undefined,
				async () => accessible,
			);
			userTokenCache.set("octocat", { accessToken: "user-token", expiresAt: Date.now() + 60_000 });
			await new Promise((resolve) => server.once("listening", resolve));

			const { status, body } = await call(server, "GET", "/account/github/available-installations");

			expect(status).toBe(200);
			expect(body).toEqual({ installations: [accessible[1]], needsReconnect: false });
		});
	});

	describe("POST /connect", () => {
		it("binds an already-accessible installation without going through the GitHub redirect", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
			const getInstallationAccount = async (installationId: number): Promise<InstallationAccount> => {
				expect(installationId).toBe(555);
				return { accountLogin: "acme-corp", accountType: "Organization" };
			};
			const { accountPath } = setup(async () => [], new StubGitHubClient(), new StubLlmProvider(), undefined, getInstallationAccount);
			await new Promise((resolve) => server.once("listening", resolve));

			const { status, body } = await call(server, "POST", "/account/github/connect", { installationId: 555 });

			expect(status).toBe(200);
			expect(body).toEqual({ connected: true, accountLogin: "acme-corp", accountType: "Organization" });

			const persisted = JSON.parse(await readFile(accountPath, "utf8")) as { installations: Record<string, unknown>[] };
			expect(persisted.installations).toEqual([
				expect.objectContaining({ installationId: 555, accountLogin: "acme-corp" }),
			]);
		});

		it("returns 400 without binding anything when the installation was revoked", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
			const revokedError = new RequestError("Not Found", 404, {
				request: { method: "GET", url: "https://api.github.com/app/installations/555", headers: {}, body: undefined },
			});
			const { accountPath } = setup(async () => [], new StubGitHubClient(), new StubLlmProvider(), undefined, async () => {
				throw revokedError;
			});
			await new Promise((resolve) => server.once("listening", resolve));

			const { status, body } = await call(server, "POST", "/account/github/connect", { installationId: 555 });

			expect(status).toBe(400);
			expect(body["error"]).toBe("That installation is no longer accessible.");
			await expect(readFile(accountPath, "utf8")).rejects.toThrow();
		});

		it("rejects a non-numeric installationId", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
			setup();
			await new Promise((resolve) => server.once("listening", resolve));

			const { status } = await call(server, "POST", "/account/github/connect", { installationId: "not-a-number" });

			expect(status).toBe(400);
		});
	});
});
