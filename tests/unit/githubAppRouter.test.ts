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
import type { GitHubClient } from "../../src/engine/github/client.js";
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
import type { InstallationAccountState } from "../../src/engine/github/installation.js";
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
		listRepos: (installationId: number, accountLogin: string) => Promise<ReadonlyArray<RepoSummary>> = async () => [],
		client: StubGitHubClient = new StubGitHubClient(),
		provider: StubLlmProvider = new StubLlmProvider(),
		initialState: InstallationAccountState | undefined = undefined,
		getInstallationAccount: (installationId: number) => Promise<InstallationAccount> = async () => ({
			accountLogin: "acme-corp",
			accountType: "Organization",
		}),
		// Selecting a repo repoints clientHolder to whatever buildClient returns for that
		// installation — defaults to always handing back the same fixture-configured
		// StubGitHubClient regardless of installationId, since a real buildInstallationClient
		// would attempt real GitHub auth with the fake appId/privateKey above. Tests exercising
		// the multi-installation client-repoint/rollback behavior pass their own buildClient.
		buildClient: (installationId: number) => GitHubClient = () => client,
		// Simulates requireSession having already run and populated res.locals.login — this
		// router is mounted after that middleware in production (see index.ts), so tests that
		// care about the starred/pinned enrichment path (which reads res.locals.login) opt in
		// by passing a login here rather than standing up the whole session stack.
		loginForRequests: string | undefined = undefined,
		enrichWithUserToken: (repos: ReadonlyArray<RepoSummary>, accessToken: string) => Promise<ReadonlyArray<RepoSummary>> = async (
			repos,
		) => repos,
		role: TeamRole = "owner",
	): { accountPath: string; state: ServerState; refreshDeps: RefreshDeps; userTokenCache: UserTokenCache } {
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
			githubAppRouter(refreshDeps, "quire-review", buildClient, listRepos, getInstallationAccount, false, userTokenCache, enrichWithUserToken),
		);
		app.use(errorHandler);
		server = app.listen(0);
		return { accountPath, state, refreshDeps, userTokenCache };
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
			selectedRepo: undefined,
			autoMergeOnAccept: false,
			flagConflictsForFleet: false,
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

	it("binds the installation on a valid callback, persisting it and swapping in a real client", async () => {
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
		const revokedError = new RequestError("Not Found", 404, {
			request: { method: "GET", url: "https://api.github.com/app/installations/555", headers: {}, body: undefined },
		});
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
			{ installations: [{ installationId: 555, accountLogin: "acme-corp", accountType: "Organization", boundAt: "2026-06-30T00:00:00.000Z" }] },
			async () => ({ accountLogin: "acme-corp", accountType: "Organization" }),
			undefined,
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
			{ installations: [{ installationId: 555, accountLogin: "acme-corp", accountType: "Organization", boundAt: "2026-06-30T00:00:00.000Z" }] },
			async () => ({ accountLogin: "acme-corp", accountType: "Organization" }),
			undefined,
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
			{ installations: [{ installationId: 555, accountLogin: "acme-corp", accountType: "Organization", boundAt: "2026-06-30T00:00:00.000Z" }] },
			async () => ({ accountLogin: "acme-corp", accountType: "Organization" }),
			undefined,
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
			{ installations: [{ installationId: 555, accountLogin: "acme-corp", accountType: "Organization", boundAt: "2026-06-30T00:00:00.000Z" }] },
			async () => ({ accountLogin: "acme-corp", accountType: "Organization" }),
			undefined,
			"octocat",
		);
		userTokenCache.set("octocat", { accessToken: "user-token", expiresAt: Date.now() + 60_000 });
		await new Promise((resolve) => server.once("listening", resolve));

		const { status, body } = await call(server, "GET", "/account/github/repos");

		expect(status).toBe(200);
		expect(body["sortingAvailable"]).toBe(true);
	});

	it("returns 400 for /repos when no installation is bound", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
		setup();
		await new Promise((resolve) => server.once("listening", resolve));

		const { status, body } = await call(server, "GET", "/account/github/repos");

		expect(status).toBe(400);
		expect(body["error"]).toBe("Install the GitHub App first");
	});

	it("selects a repo, persists it (with its owning installation), and ingests its open PRs", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
		const client = new StubGitHubClient();
		client.addFixture("acme-corp", "widgets", makePrFixture({ owner: "acme-corp", repo: "widgets" }));
		const provider = new StubLlmProvider();
		provider.queueCompletion('["adds OTP login"]');
		provider.queueCompletion(JSON.stringify([{ clause: "adds OTP login", matchedDirection: true }]));
		const { accountPath, state } = setup(async () => [], client, provider, {
			installations: [{ installationId: 555, accountLogin: "acme-corp", accountType: "Organization", boundAt: "2026-06-30T00:00:00.000Z" }],
		});
		await new Promise((resolve) => server.once("listening", resolve));

		const { status, body } = await call(server, "POST", "/account/github/repos/select", {
			owner: "acme-corp",
			name: "widgets",
			installationId: 555,
		});

		expect(status).toBe(200);
		expect(body["selected"]).toEqual({ owner: "acme-corp", name: "widgets", installationId: 555 });
		expect(body["bundlesCreated"]).toBe(1);
		expect(state.bundles.size).toBe(1);

		const persisted = JSON.parse(await readFile(accountPath, "utf8")) as Record<string, unknown>;
		expect(persisted["selectedRepo"]).toEqual({ owner: "acme-corp", name: "widgets", installationId: 555 });
	});

	it("rejects repo selection against an installation that isn't bound", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
		setup(async () => [], new StubGitHubClient(), new StubLlmProvider(), {
			installations: [{ installationId: 555, accountLogin: "acme-corp", accountType: "Organization", boundAt: "2026-06-30T00:00:00.000Z" }],
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

	it("restores the previous client and selection when a repo selection's ingest fails", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
		const workingClient = new StubGitHubClient();
		workingClient.addFixture("acme-corp", "widgets", makePrFixture({ owner: "acme-corp", repo: "widgets" }));
		class FailingClient extends StubGitHubClient {
			override async listOpenPullRequests(): Promise<never> {
				throw new Error("GitHub API unavailable");
			}
		}
		const failingClient = new FailingClient();
		const provider = new StubLlmProvider();
		provider.queueCompletion('["adds OTP login"]');
		provider.queueCompletion(JSON.stringify([{ clause: "adds OTP login", matchedDirection: true }]));
		const { state, refreshDeps } = setup(
			async () => [],
			workingClient,
			provider,
			{
				installations: [
					{ installationId: 555, accountLogin: "acme-corp", accountType: "Organization", boundAt: "2026-06-30T00:00:00.000Z" },
					{ installationId: 777, accountLogin: "octocat", accountType: "User", boundAt: "2026-06-30T00:00:00.000Z" },
				],
			},
			async () => ({ accountLogin: "acme-corp", accountType: "Organization" }),
			(installationId) => (installationId === 777 ? failingClient : workingClient),
		);
		await new Promise((resolve) => server.once("listening", resolve));

		const first = await call(server, "POST", "/account/github/repos/select", { owner: "acme-corp", name: "widgets", installationId: 555 });
		expect(first.status).toBe(200);
		expect(state.bundles.size).toBe(1);

		const second = await call(server, "POST", "/account/github/repos/select", { owner: "octocat", name: "broken-repo", installationId: 777 });

		expect(second.status).toBeGreaterThanOrEqual(400);
		// The failed selection must not leave the shared client pointed at the installation
		// that just failed, nor lose the previously-selected repo's already-ingested bundles.
		expect(refreshDeps.clientHolder.getClient()).toBe(workingClient);
		expect(refreshDeps.accountState.current.selectedRepo).toEqual({ owner: "acme-corp", name: "widgets", installationId: 555 });
		expect(state.bundles.size).toBe(1);
	});

	describe("POST /repos/setup", () => {
		it("opens a setup PR documenting and enforcing the declared-direction convention", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
			const client = new StubGitHubClient();
			setup(async () => [], client, new StubLlmProvider(), {
				installations: [{ installationId: 555, accountLogin: "acme-corp", accountType: "Organization", boundAt: "2026-06-30T00:00:00.000Z" }],
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
				installations: [{ installationId: 555, accountLogin: "acme-corp", accountType: "Organization", boundAt: "2026-06-30T00:00:00.000Z" }],
				selectedRepo: { owner: "acme-corp", name: "widgets", installationId: 555 },
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
				installations: [{ installationId: 555, accountLogin: "acme-corp", accountType: "Organization", boundAt: "2026-06-30T00:00:00.000Z" }],
			});
			await new Promise((resolve) => server.once("listening", resolve));

			const { status, body } = await call(server, "POST", "/account/github/settings", {
				autoMergeOnAccept: true,
				flagConflictsForFleet: false,
			});

			expect(status).toBe(200);
			expect(body).toEqual({ autoMergeOnAccept: true, flagConflictsForFleet: false });

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

			const { status } = await call(server, "POST", "/account/github/settings", {
				autoMergeOnAccept: true,
				flagConflictsForFleet: false,
			});

			expect(status).toBe(400);
		});
	});

	it("disconnects a single installation, leaving the others (and their selection) untouched", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
		const { accountPath } = setup(async () => [], new StubGitHubClient(), new StubLlmProvider(), {
			installations: [
				{ installationId: 555, accountLogin: "acme-corp", accountType: "Organization", boundAt: "2026-06-30T00:00:00.000Z" },
				{ installationId: 777, accountLogin: "octocat", accountType: "User", boundAt: "2026-06-30T00:00:00.000Z" },
			],
			selectedRepo: { owner: "octocat", name: "widgets", installationId: 777 },
		});
		await new Promise((resolve) => server.once("listening", resolve));

		const { status, body } = await call(server, "POST", "/account/github/disconnect/555");

		expect(status).toBe(200);
		expect(body).toEqual({ disconnected: 555, remaining: 1 });

		const persisted = JSON.parse(await readFile(accountPath, "utf8")) as { installations: unknown[]; selectedRepo?: unknown };
		expect(persisted.installations).toHaveLength(1);
		expect(persisted.selectedRepo).toEqual({ owner: "octocat", name: "widgets", installationId: 777 });
	});

	it("disconnecting the installation backing the active selection clears the selection too", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
		const { accountPath } = setup(async () => [], new StubGitHubClient(), new StubLlmProvider(), {
			installations: [{ installationId: 555, accountLogin: "acme-corp", accountType: "Organization", boundAt: "2026-06-30T00:00:00.000Z" }],
			selectedRepo: { owner: "acme-corp", name: "widgets", installationId: 555 },
		});
		await new Promise((resolve) => server.once("listening", resolve));

		const { status, body } = await call(server, "POST", "/account/github/disconnect/555");

		expect(status).toBe(200);
		expect(body).toEqual({ disconnected: 555, remaining: 0 });
		// Disconnecting the last installation tears down the file the same way disconnect-all
		// does, rather than leaving a near-empty `{"installations":[]}` behind.
		await expect(readFile(accountPath, "utf8")).rejects.toThrow();
	});

	it("rejects a non-numeric installation id on disconnect", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
		const { refreshDeps } = setup(async () => [], new StubGitHubClient(), new StubLlmProvider(), {
			installations: [{ installationId: 555, accountLogin: "acme-corp", accountType: "Organization", boundAt: "2026-06-30T00:00:00.000Z" }],
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
		});
		await new Promise((resolve) => server.once("listening", resolve));

		const { status, body } = await call(server, "POST", "/account/github/disconnect/-1");

		expect(status).toBe(400);
		expect(body["error"]).toBe("Invalid installation id");
	});

	it("disconnect-all wipes every installation and the persisted file", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
		const { accountPath } = setup(async () => [], new StubGitHubClient(), new StubLlmProvider(), {
			installations: [
				{ installationId: 555, accountLogin: "acme-corp", accountType: "Organization", boundAt: "2026-06-30T00:00:00.000Z" },
				{ installationId: 777, accountLogin: "octocat", accountType: "User", boundAt: "2026-06-30T00:00:00.000Z" },
			],
		});
		await new Promise((resolve) => server.once("listening", resolve));

		const { status, body } = await call(server, "POST", "/account/github/disconnect-all");

		expect(status).toBe(200);
		expect(body).toEqual({ connected: false });
		await expect(readFile(accountPath, "utf8")).rejects.toThrow();
	});

	it("clears the selected repo and auto-merge setting when disconnecting the last installation", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
		setup(async () => [], new StubGitHubClient(), new StubLlmProvider(), {
			installations: [{ installationId: 555, accountLogin: "acme-corp", accountType: "Organization", boundAt: "2026-06-30T00:00:00.000Z" }],
			selectedRepo: { owner: "acme-corp", name: "widgets", installationId: 555 },
			autoMergeOnAccept: true,
		});
		await new Promise((resolve) => server.once("listening", resolve));

		await call(server, "POST", "/account/github/disconnect/555");
		const { body } = await call(server, "GET", "/account/github/status");

		// Disconnecting the last installation tears the whole account-wide state down (same
		// as disconnect-all) rather than leaving a near-empty `{"installations":[]}` behind —
		// selectedRepo and autoMergeOnAccept both reset along with it. Only disconnecting one
		// of several installations preserves the account-wide selection/setting (see the
		// "leaving the others (and their selection) untouched" case above).
		expect(body).toEqual({
			connected: false,
			installations: [],
			selectedRepo: undefined,
			autoMergeOnAccept: false,
			flagConflictsForFleet: false,
		});
	});

	it("does not resurrect the cleared selection or auto-merge setting when reconnecting after the last installation was disconnected", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
		const { accountPath } = setup(async () => [], new StubGitHubClient(), new StubLlmProvider(), {
			installations: [{ installationId: 555, accountLogin: "acme-corp", accountType: "Organization", boundAt: "2026-06-30T00:00:00.000Z" }],
			selectedRepo: { owner: "acme-corp", name: "widgets", installationId: 555 },
			autoMergeOnAccept: true,
		});
		await new Promise((resolve) => server.once("listening", resolve));

		await call(server, "POST", "/account/github/disconnect/555");

		const start = await call(server, "POST", "/account/github/install/start");
		const state = new URL(start.body["installUrl"] as string).searchParams.get("state");
		const { status, location } = await callRedirect(
			server,
			`/account/github/install/callback?installation_id=555&state=${state}`,
			cookiePair(start.setCookie),
		);

		expect(status).toBe(302);
		expect(location).toBe("/?account=connected");

		// Disconnecting the last installation already wiped selectedRepo/autoMergeOnAccept
		// (see the test above) — re-binding the same installationId doesn't backfill them from
		// anywhere, since there's no separate preferences store to restore from in this model.
		const persisted = JSON.parse(await readFile(accountPath, "utf8")) as Record<string, unknown>;
		expect(persisted["selectedRepo"]).toBeUndefined();
		expect(persisted["autoMergeOnAccept"]).toBeUndefined();

		const { body } = await call(server, "GET", "/account/github/status");
		expect(body).toEqual(
			expect.objectContaining({
				connected: true,
				autoMergeOnAccept: false,
			}),
		);
		expect(body["selectedRepo"]).toBeUndefined();
	});
});
