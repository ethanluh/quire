import { describe, it, expect, afterEach } from "@jest/globals";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshRepoQueue, enqueueRefresh, NeedsReconnectError } from "../../src/interface/server/refreshRepoQueue.js";
import type { RefreshDeps } from "../../src/interface/server/refreshRepoQueue.js";
import { createAccountState } from "../../src/interface/server/accountState.js";
import { createServerState } from "../../src/interface/server/state.js";
import { GitHubClientHolder } from "../../src/engine/github/clientHolder.js";
import { StubGitHubClient } from "../../src/engine/github/stubClient.js";
import { DecidedPrStore } from "../../src/engine/queue/decidedPrStore.js";
import { AuditStore } from "../../src/engine/gate/auditStore.js";
import { StubLlmProvider } from "../mocks/llmProvider.js";
import { StubStaticAnalyzer } from "../mocks/staticAnalyzer.js";
import type { ConnectedAccount } from "../../src/engine/github/account.js";
import type { RawPRPayload } from "../../src/engine/github/client.js";
import type { OAuthDeps } from "../../src/engine/github/oauth.js";
import type { PipelineConfig } from "../../src/engine/pipeline/pipeline.js";

const PIPELINE_CONFIG: PipelineConfig = {
	gate: { criteria: [{ name: "buildFailure", mode: "enforce" }] },
	bundle: { similarityThreshold: 0.75 },
};

const BASE_ACCOUNT: ConnectedAccount = {
	login: "octocat",
	token: "ghp_abc",
	scopes: [],
	connectedAt: "2026-06-30T00:00:00.000Z",
};

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

class BlockingGitHubClient extends StubGitHubClient {
	calls = 0;
	private release: (() => void) | undefined;
	private readonly gate = new Promise<void>((resolve) => {
		this.release = resolve;
	});

	override async listOpenPullRequests(owner: string, repo: string) {
		this.calls++;
		if (this.calls === 1) await this.gate;
		return super.listOpenPullRequests(owner, repo);
	}

	releaseFirst(): void {
		this.release?.();
	}
}

describe("refreshRepoQueue", () => {
	let dir: string;

	afterEach(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	function makeDeps(overrides: {
		client?: StubGitHubClient;
		account?: ConnectedAccount;
		oauth?: OAuthDeps;
		provider?: StubLlmProvider;
	} = {}): RefreshDeps {
		const client = overrides.client ?? new StubGitHubClient();
		return {
			accountState: createAccountState(overrides.account ?? BASE_ACCOUNT),
			accountPath: join(dir, "github-account.json"),
			clientHolder: new GitHubClientHolder(client),
			oauth: overrides.oauth,
			decidedStore: new DecidedPrStore(join(dir, "decided-prs.json")),
			state: createServerState(),
			pipelineDeps: {
				config: PIPELINE_CONFIG,
				provider: overrides.provider ?? new StubLlmProvider(),
				analyzer: new StubStaticAnalyzer(),
				auditStore: new AuditStore(),
			},
		};
	}

	it("filters out PRs already marked decided before ingesting", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-refresh-"));
		const client = new StubGitHubClient();
		client.addFixture("octocat", "hello-world", makePrFixture({ id: "pr-1" }));
		client.addFixture("octocat", "hello-world", makePrFixture({ id: "pr-2", number: 2 }));
		const provider = new StubLlmProvider();
		provider.queueCompletion('["adds OTP login"]');
		provider.queueCompletion(JSON.stringify([{ clause: "adds OTP login", matchedDirection: true }]));
		const deps = makeDeps({ client, provider });
		await deps.decidedStore.markDecided(["pr-1"], "reject");

		const result = await refreshRepoQueue("octocat", "hello-world", deps);

		expect(result.bundlesCreated).toBe(1);
		const [bundle] = [...deps.state.bundles.values()];
		expect(bundle?.members.map((m) => m.id)).toEqual(["pr-2"]);
	});

	it("does not touch the token when tokenExpiresAt is unset (PAT or non-expiring OAuth token)", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-refresh-"));
		const deps = makeDeps();

		await refreshRepoQueue("octocat", "hello-world", deps);

		expect(deps.accountState.current?.token).toBe("ghp_abc");
		expect(deps.accountState.current?.needsReconnect).toBeUndefined();
	});

	// The successful-refresh path is covered directly against ensureValidAccessToken in
	// tokenRefresh.test.ts — a successful refresh here swaps the GitHubClientHolder to a
	// real OctokitGitHubClient (correct production behavior), which would otherwise make
	// this test's subsequent listOpenPullRequests call hit the real GitHub API.

	it("throws NeedsReconnectError and flags needsReconnect when the token expired with no refresh token available", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-refresh-"));
		const expiredAccount: ConnectedAccount = {
			...BASE_ACCOUNT,
			tokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
		};
		const deps = makeDeps({ account: expiredAccount });

		await expect(refreshRepoQueue("octocat", "hello-world", deps)).rejects.toBeInstanceOf(NeedsReconnectError);
	});

	it("throws NeedsReconnectError and flags needsReconnect when the refresh call itself fails", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-refresh-"));
		const expiringAccount: ConnectedAccount = {
			...BASE_ACCOUNT,
			refreshToken: "refresh-1",
			tokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
		};
		const oauth: OAuthDeps = {
			config: { clientId: "id", clientSecret: "secret" },
			buildAuthorizeUrl: () => "",
			exchangeCodeForToken: async () => ({ accessToken: "unused" }),
			refreshAccessToken: async () => {
				throw new Error("GitHub rejected the refresh token");
			},
			redirectUri: "http://localhost:3000/callback",
		};
		const deps = makeDeps({ account: expiringAccount, oauth });

		await expect(refreshRepoQueue("octocat", "hello-world", deps)).rejects.toBeInstanceOf(NeedsReconnectError);
	});

	it("re-clusters the full undecided set on every call, not just newly-arrived PRs", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-refresh-"));
		const client = new StubGitHubClient();
		client.addFixture("octocat", "hello-world", makePrFixture({ id: "pr-1", declaredDirection: "direction one" }));
		const provider = new StubLlmProvider();
		provider.queueCompletion('["does one"]');
		provider.queueCompletion(JSON.stringify([{ clause: "does one", matchedDirection: true }]));
		const deps = makeDeps({ client, provider });

		await refreshRepoQueue("octocat", "hello-world", deps);
		expect(deps.state.bundles.size).toBe(1);

		provider.queueCompletion('["does one"]');
		provider.queueCompletion(JSON.stringify([{ clause: "does one", matchedDirection: true }]));
		await refreshRepoQueue("octocat", "hello-world", deps);

		expect(deps.state.bundles.size).toBe(1);
	});
});

describe("enqueueRefresh", () => {
	let dir: string;

	afterEach(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	it("serializes overlapping refresh calls for the same repo instead of racing", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-refresh-"));
		const client = new BlockingGitHubClient();
		const deps: RefreshDeps = {
			accountState: createAccountState(BASE_ACCOUNT),
			accountPath: join(dir, "github-account.json"),
			clientHolder: new GitHubClientHolder(client),
			oauth: undefined,
			decidedStore: new DecidedPrStore(join(dir, "decided-prs.json")),
			state: createServerState(),
			pipelineDeps: {
				config: PIPELINE_CONFIG,
				provider: new StubLlmProvider(),
				analyzer: new StubStaticAnalyzer(),
				auditStore: new AuditStore(),
			},
		};

		const first = enqueueRefresh("octocat", "hello-world", deps);
		const second = enqueueRefresh("octocat", "hello-world", deps);

		await new Promise((resolve) => setImmediate(resolve));
		expect(client.calls).toBe(1); // second call hasn't started — it's queued behind the first

		client.releaseFirst();
		await Promise.all([first, second]);

		expect(client.calls).toBe(2);
	});
});
