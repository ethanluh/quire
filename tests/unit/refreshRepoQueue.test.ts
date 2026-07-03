import { describe, it, expect, afterEach } from "@jest/globals";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RequestError } from "@octokit/request-error";
import { refreshRepoQueue, enqueueRefresh, InstallationRevokedError, AccountChangedError } from "../../src/interface/server/refreshRepoQueue.js";
import type { RefreshDeps } from "../../src/interface/server/refreshRepoQueue.js";
import { onStateChanged } from "../../src/interface/server/changeEvents.js";
import { createAccountState } from "../../src/interface/server/accountState.js";
import { createServerState } from "../../src/interface/server/state.js";
import { GitHubClientHolder } from "../../src/engine/github/clientHolder.js";
import { StubGitHubClient } from "../../src/engine/github/stubClient.js";
import { DecidedPrStore } from "../../src/engine/queue/decidedPrStore.js";
import { AuditStore } from "../../src/engine/gate/auditStore.js";
import { PrEffectCache } from "../../src/engine/cache/prCache.js";
import { StubLlmProvider } from "../mocks/llmProvider.js";
import { StubStaticAnalyzer } from "../mocks/staticAnalyzer.js";
import type { InstallationBinding } from "../../src/engine/github/installation.js";
import type { RawPRPayload } from "../../src/engine/github/client.js";
import type { PipelineConfig } from "../../src/engine/pipeline/pipeline.js";

const PIPELINE_CONFIG: PipelineConfig = {
	gate: { criteria: [{ name: "buildFailure", mode: "enforce" }] },
	bundle: { similarityThreshold: 0.75 },
};

const BASE_BINDING: InstallationBinding = {
	installationId: 1,
	accountLogin: "octocat",
	accountType: "User",
	boundAt: "2026-06-30T00:00:00.000Z",
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

class RevokedGitHubClient extends StubGitHubClient {
	override async listOpenPullRequests(): Promise<never> {
		throw new RequestError("Not Found", 404, { request: { method: "GET", url: "", headers: {} } });
	}
}

describe("refreshRepoQueue", () => {
	let dir: string;

	afterEach(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	function makeDeps(overrides: {
		client?: StubGitHubClient;
		binding?: InstallationBinding;
		provider?: StubLlmProvider;
	} = {}): RefreshDeps {
		const client = overrides.client ?? new StubGitHubClient();
		const binding = overrides.binding ?? BASE_BINDING;
		return {
			accountState: createAccountState({
				installations: [binding],
				selectedRepo: { owner: "octocat", name: "hello-world", installationId: binding.installationId },
			}),
			accountPath: join(dir, "installation.json"),
			clientHolder: new GitHubClientHolder(client),
			appConfig: { appId: "1", privateKey: "unused" },
			decidedStore: new DecidedPrStore(join(dir, "decided-prs.json")),
			state: createServerState(),
			pipelineDeps: {
				config: PIPELINE_CONFIG,
				provider: overrides.provider ?? new StubLlmProvider(),
				analyzer: new StubStaticAnalyzer(),
				auditStore: new AuditStore(),
				prCache: new PrEffectCache(),
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

	it("throws InstallationRevokedError when GitHub 404s the PR list (installation lost access)", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-refresh-"));
		const deps = makeDeps({ client: new RevokedGitHubClient() });

		await expect(refreshRepoQueue("octocat", "hello-world", deps)).rejects.toBeInstanceOf(InstallationRevokedError);
	});

	it("throws a plain error, not InstallationRevokedError, for an unrelated failure", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-refresh-"));
		class FailingClient extends StubGitHubClient {
			override async listOpenPullRequests(): Promise<never> {
				throw new Error("network blip");
			}
		}
		const deps = makeDeps({ client: new FailingClient() });

		await expect(refreshRepoQueue("octocat", "hello-world", deps)).rejects.not.toBeInstanceOf(InstallationRevokedError);
	});

	it("does not resurrect the binding if it's disconnected while a refresh is in flight", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-refresh-"));
		let releaseFetch: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			releaseFetch = resolve;
		});
		class GatedClient extends StubGitHubClient {
			override async listOpenPullRequests(owner: string, repo: string) {
				await gate;
				return super.listOpenPullRequests(owner, repo);
			}
		}
		const deps = makeDeps({ client: new GatedClient() });

		const refreshPromise = refreshRepoQueue("octocat", "hello-world", deps);
		await new Promise((resolve) => setImmediate(resolve));
		deps.accountState.current = { installations: [] }; // simulates a concurrent /disconnect-all

		releaseFetch();
		await expect(refreshPromise).rejects.toBeInstanceOf(AccountChangedError);
		expect(deps.accountState.current).toEqual({ installations: [] });
	});

	it("does not abort when an unrelated installation is bound mid-flight, only when the active one/repo changes", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-refresh-"));
		let releaseFetch: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			releaseFetch = resolve;
		});
		class GatedClient extends StubGitHubClient {
			override async listOpenPullRequests(owner: string, repo: string) {
				await gate;
				return super.listOpenPullRequests(owner, repo);
			}
		}
		const deps = makeDeps({ client: new GatedClient() });

		const refreshPromise = refreshRepoQueue("octocat", "hello-world", deps);
		await new Promise((resolve) => setImmediate(resolve));
		// An unrelated second installation gets bound while this refresh is in flight — the
		// active installation and selected repo are untouched, so this must NOT be treated
		// as a stale binding.
		const unrelatedBinding: InstallationBinding = {
			installationId: 99,
			accountLogin: "acme-corp",
			accountType: "Organization",
			boundAt: "2026-06-30T00:00:00.000Z",
		};
		deps.accountState.current = { ...deps.accountState.current, installations: [...deps.accountState.current.installations, unrelatedBinding] };

		releaseFetch();
		await expect(refreshPromise).resolves.toBeDefined();
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
			accountState: createAccountState({
				installations: [BASE_BINDING],
				selectedRepo: { owner: "octocat", name: "hello-world", installationId: BASE_BINDING.installationId },
			}),
			accountPath: join(dir, "installation.json"),
			clientHolder: new GitHubClientHolder(client),
			appConfig: { appId: "1", privateKey: "unused" },
			decidedStore: new DecidedPrStore(join(dir, "decided-prs.json")),
			state: createServerState(),
			pipelineDeps: {
				config: PIPELINE_CONFIG,
				provider: new StubLlmProvider(),
				analyzer: new StubStaticAnalyzer(),
				auditStore: new AuditStore(),
				prCache: new PrEffectCache(),
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

	it("pushes a state-changed notification after each successful refresh, so an open SSE connection doesn't wait for the next poll tick", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-refresh-"));
		const deps: RefreshDeps = {
			accountState: createAccountState({
				installations: [BASE_BINDING],
				selectedRepo: { owner: "octocat", name: "hello-world", installationId: BASE_BINDING.installationId },
			}),
			accountPath: join(dir, "installation.json"),
			clientHolder: new GitHubClientHolder(new StubGitHubClient()),
			appConfig: { appId: "1", privateKey: "unused" },
			decidedStore: new DecidedPrStore(join(dir, "decided-prs.json")),
			state: createServerState(),
			pipelineDeps: {
				config: PIPELINE_CONFIG,
				provider: new StubLlmProvider(),
				analyzer: new StubStaticAnalyzer(),
				auditStore: new AuditStore(),
				prCache: new PrEffectCache(),
			},
		};
		let notifyCount = 0;
		const unsubscribe = onStateChanged(() => { notifyCount += 1; });

		await enqueueRefresh("octocat", "hello-world", deps);
		await enqueueRefresh("octocat", "hello-world", deps);

		expect(notifyCount).toBe(2);
		unsubscribe();
	});
});
