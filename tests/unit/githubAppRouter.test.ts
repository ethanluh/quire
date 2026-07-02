import { describe, it, expect, afterEach, jest } from "@jest/globals";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { request as httpRequest } from "node:http";
import type { Server } from "node:http";
import { githubAppRouter } from "../../src/interface/server/routes/githubApp.js";
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
import { StubStaticAnalyzer } from "../mocks/staticAnalyzer.js";
import type { InstallationBinding } from "../../src/engine/github/installation.js";
import type { PipelineConfig } from "../../src/engine/pipeline/pipeline.js";
import type { PipelineDeps } from "../../src/interface/server/ingestIntoQueue.js";
import type { RawPRPayload } from "../../src/engine/github/client.js";

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
}

async function call(server: Server, method: string, path: string, body?: unknown): Promise<JsonResponse> {
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("no address");
	const init: RequestInit = { method, headers: { "Content-Type": "application/json" } };
	if (body !== undefined) init.body = JSON.stringify(body);
	const res = await fetch(`http://127.0.0.1:${address.port}${path}`, init);
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

interface RedirectResponse {
	status: number;
	location: string | undefined;
}

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
	): { accountPath: string; state: ServerState; refreshDeps: RefreshDeps } {
		const accountPath = join(dir, "installation.json");
		const holder = new GitHubClientHolder(client);
		const state = createServerState();
		const accountState = createAccountState(initialBinding);
		const decidedStore = new DecidedPrStore(join(dir, "decided-prs.json"));
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
		app.use("/account/github", githubAppRouter(refreshDeps, "quire-review", { appId: "1", privateKey: "unused" }, listRepos));
		app.use(errorHandler);
		server = app.listen(0);
		return { accountPath, state, refreshDeps };
	}

	it("reports not connected when no installation is bound", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
		setup();
		await new Promise((resolve) => server.once("listening", resolve));

		const { status, body } = await call(server, "GET", "/account/github/status");

		expect(status).toBe(200);
		expect(body).toEqual({ connected: false });
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

	it("reuses the same pending state across repeated /install/start calls", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
		setup();
		await new Promise((resolve) => server.once("listening", resolve));

		const first = await call(server, "POST", "/account/github/install/start");
		const second = await call(server, "POST", "/account/github/install/start");

		const firstState = new URL(first.body["installUrl"] as string).searchParams.get("state");
		const secondState = new URL(second.body["installUrl"] as string).searchParams.get("state");
		expect(firstState).toBe(secondState);
	});

	it("binds the installation on a valid callback, persisting it and swapping in a real client", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
		const repos: ReadonlyArray<RepoSummary> = [
			{ owner: "acme-corp", name: "widgets", fullName: "acme-corp/widgets", private: false, defaultBranch: "main" },
		];
		const { accountPath } = setup(async () => repos);
		await new Promise((resolve) => server.once("listening", resolve));
		const start = await call(server, "POST", "/account/github/install/start");
		const state = new URL(start.body["installUrl"] as string).searchParams.get("state");

		const { status, location } = await callRedirect(
			server,
			`/account/github/install/callback?installation_id=555&state=${state}`,
		);

		expect(status).toBe(302);
		expect(location).toBe("/?account=connected");

		const persisted = JSON.parse(await readFile(accountPath, "utf8")) as Record<string, unknown>;
		expect(persisted["installationId"]).toBe(555);
		expect(persisted["accountLogin"]).toBe("acme-corp");

		const statusResult = await call(server, "GET", "/account/github/status");
		expect(statusResult.body).toEqual(expect.objectContaining({ connected: true, accountLogin: "acme-corp" }));
	});

	it("rejects an install callback whose state doesn't match the pending one", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
		const { accountPath } = setup();
		await new Promise((resolve) => server.once("listening", resolve));
		await call(server, "POST", "/account/github/install/start");

		const { status, location } = await callRedirect(
			server,
			"/account/github/install/callback?installation_id=555&state=wrong",
		);

		expect(status).toBe(302);
		expect(location).toContain("account=error");
		await expect(readFile(accountPath, "utf8")).rejects.toThrow();
	});

	it("lists repos for the bound installation", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-githubapp-"));
		const repos: ReadonlyArray<RepoSummary> = [
			{ owner: "acme-corp", name: "widgets", fullName: "acme-corp/widgets", private: false, defaultBranch: "main" },
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
});
