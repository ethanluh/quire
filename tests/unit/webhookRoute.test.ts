import { describe, it, expect, afterEach } from "@jest/globals";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import type { Server } from "node:http";
import { webhookRouter } from "../../src/interface/server/routes/webhook.js";
import type { WebhookRouterOptions } from "../../src/interface/server/routes/webhook.js";
import type { RefreshDeps } from "../../src/interface/server/refreshRepoQueue.js";
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
import { MergeQueue } from "../../src/engine/queue/mergeQueue.js";
import { LlmProviderHolder } from "../../src/engine/drift/effectList/providerHolder.js";
import type { Bundle, PullRequest } from "../../src/engine/types/core.js";
import type { MergeabilityResult } from "../../src/engine/types/mergeability.js";
import type { MergeQueueEntry, MergeQueueEntryStatus } from "../../src/engine/types/queue.js";

const PIPELINE_CONFIG: PipelineConfig = {
	gate: { criteria: [{ name: "buildFailure", mode: "enforce" }] },
	bundle: { similarityThreshold: 0.75 },
};

const BINDING: InstallationBinding = {
	installationId: 1,
	accountLogin: "octocat",
	accountType: "User",
	boundAt: "2026-06-30T00:00:00.000Z",
};

function makePrFixture(overrides: Partial<RawPRPayload> = {}): RawPRPayload {
	return {
		id: "123",
		number: 1,
		owner: "octocat",
		repo: "hello-world",
		title: "Add OTP login",
		body: "",
		headSha: "sha-1",
		diff: "diff --git a/src/auth.ts b/src/auth.ts\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -0,0 +1 @@\n+export function login() {}\n",
		ciStatus: "success",
		declaredDirection: "add passwordless auth",
		directionInferred: false,
		filesTouched: ["src/auth.ts"],
		...overrides,
	};
}

function pullRequestEventPayload(owner: string, repo: string, action: string, prId = 123, installationId = BINDING.installationId): unknown {
	return {
		action,
		repository: { owner: { login: owner }, name: repo },
		pull_request: { id: prId },
		installation: { id: installationId },
	};
}

function makeQueuedPr(id: string): PullRequest {
	return {
		id,
		repoOwner: "octocat",
		repoName: "hello-world",
		number: 1,
		headSha: "sha-1",
		declaredDirection: "add passwordless auth",
		directionInferred: false,
		diff: { raw: "", hunks: [] },
		filesTouched: ["src/auth.ts"],
		symbolsTouched: [],
		testNamesChanged: [],
		ciStatus: "success",
	};
}

function makeBundleFor(pr: PullRequest): Bundle {
	return {
		id: `bundle-${pr.id}`,
		direction: pr.declaredDirection,
		directionInferred: pr.directionInferred,
		effectSummary: "adds OTP-based login",
		members: [pr],
	};
}

function makeMergeability(overrides: Partial<MergeabilityResult> = {}): MergeabilityResult {
	return {
		state: "clean",
		isFork: false,
		merged: false,
		headBranch: "feature",
		headSha: "sha-1",
		baseBranch: "main",
		baseSha: "base-sha",
		...overrides,
	};
}

// The auto-merge-on-approval path (see gestures.ts) runs as a fire-and-forget background call
// after the webhook responds 202, so a fixed sleep before asserting the landed status is a race
// against however long that background call actually takes under CI load. Poll instead, same
// pattern as gestures.test.ts's waitForEntryStatus.
async function waitForEntryStatus(
	queue: MergeQueue,
	bundleId: string,
	status: MergeQueueEntryStatus,
	timeoutMs = 1000,
): Promise<MergeQueueEntry> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const entry = await queue.getEntry(bundleId);
		if (entry?.status === status) return entry;
		if (Date.now() > deadline) {
			throw new Error(`Timed out waiting for bundle ${bundleId} to reach status "${status}" (last: ${entry?.status})`);
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe("webhookRouter", () => {
	let dir: string;
	let server: Server;

	afterEach(async () => {
		if (server) await new Promise((resolve) => server.close(resolve));
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	async function setup(
		client: StubGitHubClient = new StubGitHubClient(),
		provider = new StubLlmProvider(),
		options?: WebhookRouterOptions,
	): Promise<{ refreshDeps: RefreshDeps; queue: MergeQueue }> {
		const queue = new MergeQueue(join(dir, "queue.json"), client, new LlmProviderHolder(new StubLlmProvider()), join(dir, "conflict.ndjson"));
		await queue.load();
		const refreshDeps: RefreshDeps = {
			accountState: createAccountState({
				installations: [BINDING],
				repos: [
					{
						owner: "octocat",
						name: "hello-world",
						installationId: BINDING.installationId,
						addedAt: new Date(0).toISOString(),
						addedBy: "test-user",
					},
				],
			}),
			accountPath: join(dir, "installation.json"),
			clientHolder: new GitHubClientHolder(client),
			appConfig: { appId: "1", privateKey: "unused" },
			decidedStore: new DecidedPrStore(join(dir, "decided-prs.json")),
			state: createServerState(),
			pipelineDeps: {
				config: PIPELINE_CONFIG,
				provider,
				analyzer: new StubStaticAnalyzer(),
				auditStore: new AuditStore(),
				prCache: new PrEffectCache(),
			},
			queue,
		};
		const app = express();
		app.use(express.raw({ type: "application/json" }));
		app.use(webhookRouter((installationId) => (installationId === BINDING.installationId ? [{ refreshDeps }] : []), options));
		server = app.listen(0);
		return { refreshDeps, queue };
	}

	async function post(payload: unknown, event: string, deliveryId?: string): Promise<{ status: number; body: unknown }> {
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("no address");
		const headers: Record<string, string> = { "Content-Type": "application/json", "X-GitHub-Event": event };
		if (deliveryId !== undefined) headers["X-GitHub-Delivery"] = deliveryId;
		const res = await fetch(`http://127.0.0.1:${address.port}/`, {
			method: "POST",
			headers,
			body: JSON.stringify(payload),
		});
		return { status: res.status, body: await res.json() };
	}

	it("acknowledges ping events without triggering a refresh", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-webhook-"));
		await setup();

		const { status, body } = await post({ zen: "hello" }, "ping");

		expect(status).toBe(200);
		expect(body).toEqual({ pong: true });
	});

	it("ignores non-pull_request events", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-webhook-"));
		await setup();

		const { status, body } = await post({}, "push");

		expect(status).toBe(200);
		expect(body).toEqual({ ignored: true });
	});

	it("ignores a pull_request event for a repo that isn't currently selected", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-webhook-"));
		const client = new StubGitHubClient();
		client.addFixture("octocat", "other-repo", makePrFixture({ repo: "other-repo" }));
		await setup(client);

		const { status, body } = await post(pullRequestEventPayload("octocat", "other-repo", "opened"), "pull_request");

		expect(status).toBe(200);
		expect(body).toEqual({ ignored: true });
	});

	it("ignores a pull_request action that isn't a trigger action", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-webhook-"));
		await setup();

		const { status, body } = await post(pullRequestEventPayload("octocat", "hello-world", "labeled"), "pull_request");

		expect(status).toBe(200);
		expect(body).toEqual({ ignored: true });
	});

	it("acks 202 for a matching repo and trigger action, then ingests the PR asynchronously", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-webhook-"));
		const client = new StubGitHubClient();
		client.addFixture("octocat", "hello-world", makePrFixture());
		const provider = new StubLlmProvider();
		provider.queueCompletion('["adds OTP login"]');
		provider.queueCompletion(JSON.stringify([{ clause: "adds OTP login", matchedDirection: true }]));
		const { refreshDeps } = await setup(client, provider);

		const { status, body } = await post(pullRequestEventPayload("octocat", "hello-world", "opened"), "pull_request");

		expect(status).toBe(202);
		expect(body).toEqual({ accepted: true });

		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(refreshDeps.state.bundles.size).toBe(1);
	});

	it("ingests on an edited event, so a fixed declared-direction marker shows up without a new push", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-webhook-"));
		const client = new StubGitHubClient();
		client.addFixture("octocat", "hello-world", makePrFixture());
		const provider = new StubLlmProvider();
		provider.queueCompletion('["adds OTP login"]');
		provider.queueCompletion(JSON.stringify([{ clause: "adds OTP login", matchedDirection: true }]));
		const { refreshDeps } = await setup(client, provider);

		const { status, body } = await post(pullRequestEventPayload("octocat", "hello-world", "edited"), "pull_request");

		expect(status).toBe(202);
		expect(body).toEqual({ accepted: true });
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(refreshDeps.state.bundles.size).toBe(1);
	});

	it("treats converted_to_draft as a trigger action", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-webhook-"));
		await setup();

		const { status, body } = await post(pullRequestEventPayload("octocat", "hello-world", "converted_to_draft"), "pull_request");

		expect(status).toBe(202);
		expect(body).toEqual({ accepted: true });
	});

	it("ignores a redelivery that reuses an already-processed X-GitHub-Delivery id", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-webhook-"));
		const client = new StubGitHubClient();
		client.addFixture("octocat", "hello-world", makePrFixture());
		const provider = new StubLlmProvider();
		provider.queueCompletion('["adds OTP login"]');
		provider.queueCompletion(JSON.stringify([{ clause: "adds OTP login", matchedDirection: true }]));
		await setup(client, provider);
		let refreshes = 0;
		const original = client.listOpenPullRequests.bind(client);
		client.listOpenPullRequests = async (owner: string, repo: string) => {
			refreshes++;
			return original(owner, repo);
		};

		const first = await post(pullRequestEventPayload("octocat", "hello-world", "opened"), "pull_request", "guid-1");
		const second = await post(pullRequestEventPayload("octocat", "hello-world", "opened"), "pull_request", "guid-1");

		expect(first.status).toBe(202);
		expect(second.status).toBe(200);
		expect(second.body).toEqual({ ignored: true });
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(refreshes).toBe(1);
	});

	it("processes a manual redelivery after the original delivery's retries were exhausted", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-webhook-"));
		const client = new StubGitHubClient();
		client.addFixture("octocat", "hello-world", makePrFixture());
		const provider = new StubLlmProvider();
		provider.queueCompletion('["adds OTP login"]');
		provider.queueCompletion(JSON.stringify([{ clause: "adds OTP login", matchedDirection: true }]));
		const { refreshDeps } = await setup(client, provider, { retryDelaysMs: [] });
		let calls = 0;
		const original = client.listOpenPullRequests.bind(client);
		client.listOpenPullRequests = async (owner: string, repo: string) => {
			if (calls++ === 0) throw new Error("GitHub outage");
			return original(owner, repo);
		};

		const first = await post(pullRequestEventPayload("octocat", "hello-world", "opened"), "pull_request", "guid-2");
		expect(first.status).toBe(202);
		await new Promise((resolve) => setTimeout(resolve, 50)); // fails, gives up, forgets the delivery id

		const redelivery = await post(pullRequestEventPayload("octocat", "hello-world", "opened"), "pull_request", "guid-2");

		expect(redelivery.status).toBe(202); // not swallowed as a duplicate
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(refreshDeps.state.bundles.size).toBe(1);
	});

	it("retries the post-ack refresh after a transient failure instead of losing the delivery", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-webhook-"));
		const client = new StubGitHubClient();
		client.addFixture("octocat", "hello-world", makePrFixture());
		const provider = new StubLlmProvider();
		provider.queueCompletion('["adds OTP login"]');
		provider.queueCompletion(JSON.stringify([{ clause: "adds OTP login", matchedDirection: true }]));
		const { refreshDeps } = await setup(client, provider, { retryDelaysMs: [10, 10] });
		let calls = 0;
		const original = client.listOpenPullRequests.bind(client);
		client.listOpenPullRequests = async (owner: string, repo: string) => {
			if (calls++ === 0) throw new Error("transient GitHub API error");
			return original(owner, repo);
		};

		const { status } = await post(pullRequestEventPayload("octocat", "hello-world", "opened"), "pull_request");

		expect(status).toBe(202);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(calls).toBe(2);
		expect(refreshDeps.state.bundles.size).toBe(1);
	});

	it("clears the decided-PR entry on a synchronize event before refreshing, so a reworked PR reappears", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-webhook-"));
		const client = new StubGitHubClient();
		client.addFixture("octocat", "hello-world", makePrFixture({ id: "123" }));
		const provider = new StubLlmProvider();
		provider.queueCompletion('["adds OTP login"]');
		provider.queueCompletion(JSON.stringify([{ clause: "adds OTP login", matchedDirection: true }]));
		const { refreshDeps } = await setup(client, provider);
		await refreshDeps.decidedStore.markDecided(["123"], "reject", { decidedBy: "tester", bundleId: "test-bundle" });

		const { status } = await post(pullRequestEventPayload("octocat", "hello-world", "synchronize", 123), "pull_request");

		expect(status).toBe(202);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(refreshDeps.decidedStore.isDecided("123")).toBe(false);
		expect(refreshDeps.state.bundles.size).toBe(1);
	});

	it("clears a matching \"conflict\" queue entry on synchronize, without merging when autoMergeOnAccept is off", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-webhook-"));
		const client = new StubGitHubClient();
		const { queue } = await setup(client);
		const pr = makeQueuedPr("123");
		client.setMergeability(pr.repoOwner, pr.repoName, pr.number, makeMergeability({ state: "blocked" }));
		await queue.enqueue(makeBundleFor(pr));
		const blocked = await queue.dequeueNext();
		expect(blocked?.status).toBe("conflict");

		client.setMergeability(pr.repoOwner, pr.repoName, pr.number, makeMergeability({ state: "clean" }));
		const { status } = await post(pullRequestEventPayload("octocat", "hello-world", "synchronize", 123), "pull_request");

		expect(status).toBe(202);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect((await queue.getEntry(makeBundleFor(pr).id))?.status).toBe("queued");
		expect(client.mergedPrs).toEqual([]);
	});

	it("also lands the bundle on synchronize when autoMergeOnAccept is on", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-webhook-"));
		const client = new StubGitHubClient();
		const { refreshDeps, queue } = await setup(client);
		refreshDeps.accountState.current = {
			...refreshDeps.accountState.current,
			repos: refreshDeps.accountState.current.repos.map((r) => ({ ...r, autoMergeOnAccept: true })),
		};
		const pr = makeQueuedPr("123");
		client.setMergeability(pr.repoOwner, pr.repoName, pr.number, makeMergeability({ state: "blocked" }));
		await queue.enqueue(makeBundleFor(pr));
		const blocked = await queue.dequeueNext();
		expect(blocked?.status).toBe("conflict");

		client.setMergeability(pr.repoOwner, pr.repoName, pr.number, makeMergeability({ state: "clean" }));
		const { status } = await post(pullRequestEventPayload("octocat", "hello-world", "synchronize", 123), "pull_request");

		expect(status).toBe(202);
		await waitForEntryStatus(queue, makeBundleFor(pr).id, "landed");
		expect(client.mergedPrs).toEqual([`${pr.repoOwner}/${pr.repoName}/${pr.number}`]);
	});

	it("is a no-op on the queue when a synchronize event's PR has no matching conflict entry", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-webhook-"));
		const client = new StubGitHubClient();
		const { queue } = await setup(client);

		const { status } = await post(pullRequestEventPayload("octocat", "hello-world", "synchronize", 123), "pull_request");

		expect(status).toBe(202);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(await queue.listEntries()).toHaveLength(0);
	});

	it("fans a delivery out to every team that has the same installation bound, not just one", async () => {
		// One GitHub App installation can now be bound by several Quire teams at once (the
		// feature this test file was extended for) — a delivery for that installation must
		// reach every team watching the repo, not just whichever team's tenant happened to be
		// found first.
		dir = await mkdtemp(join(tmpdir(), "quire-webhook-"));
		const clientA = new StubGitHubClient();
		const clientB = new StubGitHubClient();
		const queueA = new MergeQueue(join(dir, "queue-a.json"), clientA, new LlmProviderHolder(new StubLlmProvider()), join(dir, "conflict-a.ndjson"));
		const queueB = new MergeQueue(join(dir, "queue-b.json"), clientB, new LlmProviderHolder(new StubLlmProvider()), join(dir, "conflict-b.ndjson"));
		await queueA.load();
		await queueB.load();

		function makeRefreshDeps(client: StubGitHubClient, queue: MergeQueue, suffix: string): RefreshDeps {
			return {
				accountState: createAccountState({
					installations: [BINDING],
					repos: [
						{
							owner: "octocat",
							name: "hello-world",
							installationId: BINDING.installationId,
							addedAt: new Date(0).toISOString(),
							addedBy: "test-user",
						},
					],
				}),
				accountPath: join(dir, `installation-${suffix}.json`),
				clientHolder: new GitHubClientHolder(client),
				appConfig: { appId: "1", privateKey: "unused" },
				decidedStore: new DecidedPrStore(join(dir, `decided-prs-${suffix}.json`)),
				state: createServerState(),
				pipelineDeps: {
					config: PIPELINE_CONFIG,
					provider: new StubLlmProvider(),
					analyzer: new StubStaticAnalyzer(),
					auditStore: new AuditStore(),
					prCache: new PrEffectCache(),
				},
				queue,
			};
		}

		const refreshDepsA = makeRefreshDeps(clientA, queueA, "a");
		const refreshDepsB = makeRefreshDeps(clientB, queueB, "b");
		await refreshDepsA.decidedStore.markDecided(["123"], "reject", { decidedBy: "tester", bundleId: "test-bundle" });
		await refreshDepsB.decidedStore.markDecided(["123"], "reject", { decidedBy: "tester", bundleId: "test-bundle" });

		const app = express();
		app.use(express.raw({ type: "application/json" }));
		app.use(
			webhookRouter((installationId) =>
				installationId === BINDING.installationId ? [{ refreshDeps: refreshDepsA }, { refreshDeps: refreshDepsB }] : [],
			),
		);
		server = app.listen(0);

		const { status } = await post(pullRequestEventPayload("octocat", "hello-world", "synchronize", 123), "pull_request");

		expect(status).toBe(202);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(refreshDepsA.decidedStore.isDecided("123")).toBe(false);
		expect(refreshDepsB.decidedStore.isDecided("123")).toBe(false);
	});

	it("ignores non-pull_request events even when they look like a GitHub payload", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-webhook-"));
		await setup();

		const { status, body } = await post({ action: "completed" }, "workflow_run");

		expect(status).toBe(200);
		expect(body).toEqual({ ignored: true });
	});

	function checkSuiteEventPayload(
		owner: string,
		repo: string,
		action: string,
		conclusion: string | null,
		prIds: number[],
		installationId = BINDING.installationId,
	): unknown {
		return {
			action,
			check_suite: { conclusion, pull_requests: prIds.map((id) => ({ id, number: 1 })) },
			repository: { owner: { login: owner }, name: repo },
			installation: { id: installationId },
		};
	}

	it("ignores a check_suite event that hasn't completed yet", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-webhook-"));
		const client = new StubGitHubClient();
		const { queue } = await setup(client);
		const pr = makeQueuedPr("123");
		client.setMergeability(pr.repoOwner, pr.repoName, pr.number, makeMergeability({ state: "blocked" }));
		await queue.enqueue(makeBundleFor(pr));
		await queue.dequeueNext();

		const { status, body } = await post(checkSuiteEventPayload("octocat", "hello-world", "in_progress", null, [123]), "check_suite");

		expect(status).toBe(200);
		expect(body).toEqual({ ignored: true });
		expect((await queue.getEntry(makeBundleFor(pr).id))?.status).toBe("conflict");
	});

	it("ignores a completed check_suite that didn't succeed", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-webhook-"));
		const client = new StubGitHubClient();
		const { queue } = await setup(client);
		const pr = makeQueuedPr("123");
		client.setMergeability(pr.repoOwner, pr.repoName, pr.number, makeMergeability({ state: "blocked" }));
		await queue.enqueue(makeBundleFor(pr));
		await queue.dequeueNext();

		const { status, body } = await post(checkSuiteEventPayload("octocat", "hello-world", "completed", "failure", [123]), "check_suite");

		expect(status).toBe(200);
		expect(body).toEqual({ ignored: true });
		expect((await queue.getEntry(makeBundleFor(pr).id))?.status).toBe("conflict");
	});

	it("clears a matching \"waitingOnChecks\" queue entry when a check_suite succeeds, without merging when autoMergeOnAccept is off", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-webhook-"));
		const client = new StubGitHubClient();
		const { queue } = await setup(client);
		const pr = makeQueuedPr("123");
		client.setMergeability(pr.repoOwner, pr.repoName, pr.number, makeMergeability({ state: "unstable" }));
		await queue.enqueue(makeBundleFor(pr));
		const blocked = await queue.dequeueNext();
		expect(blocked?.status).toBe("waitingOnChecks");
		expect(blocked?.waitingOnChecks?.prId).toBe(pr.id);

		client.setMergeability(pr.repoOwner, pr.repoName, pr.number, makeMergeability({ state: "clean" }));
		const { status } = await post(checkSuiteEventPayload("octocat", "hello-world", "completed", "success", [123]), "check_suite");

		expect(status).toBe(202);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect((await queue.getEntry(makeBundleFor(pr).id))?.status).toBe("queued");
		expect(client.mergedPrs).toEqual([]);
	});

	it("also lands the bundle when a check_suite succeeds and autoMergeOnAccept is on", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-webhook-"));
		const client = new StubGitHubClient();
		const { refreshDeps, queue } = await setup(client);
		refreshDeps.accountState.current = {
			...refreshDeps.accountState.current,
			repos: refreshDeps.accountState.current.repos.map((r) => ({ ...r, autoMergeOnAccept: true })),
		};
		const pr = makeQueuedPr("123");
		client.setMergeability(pr.repoOwner, pr.repoName, pr.number, makeMergeability({ state: "unstable" }));
		await queue.enqueue(makeBundleFor(pr));
		const blocked = await queue.dequeueNext();
		expect(blocked?.status).toBe("waitingOnChecks");

		client.setMergeability(pr.repoOwner, pr.repoName, pr.number, makeMergeability({ state: "clean" }));
		const { status } = await post(checkSuiteEventPayload("octocat", "hello-world", "completed", "success", [123]), "check_suite");

		expect(status).toBe(202);
		await waitForEntryStatus(queue, makeBundleFor(pr).id, "landed");
		expect(client.mergedPrs).toEqual([`${pr.repoOwner}/${pr.repoName}/${pr.number}`]);
	});

	it("is a no-op when a check_suite's PR has no matching conflict entry", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-webhook-"));
		const client = new StubGitHubClient();
		const { queue } = await setup(client);

		const { status } = await post(checkSuiteEventPayload("octocat", "hello-world", "completed", "success", [123]), "check_suite");

		expect(status).toBe(202);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(await queue.listEntries()).toHaveLength(0);
	});

	function pullRequestReviewEventPayload(
		owner: string,
		repo: string,
		action: string,
		reviewState: string | null,
		prId = 123,
		installationId = BINDING.installationId,
	): unknown {
		return {
			action,
			review: { state: reviewState },
			pull_request: { id: prId },
			repository: { owner: { login: owner }, name: repo },
			installation: { id: installationId },
		};
	}

	it("ignores a pull_request_review that isn't a submitted approval", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-webhook-"));
		const client = new StubGitHubClient();
		const { queue } = await setup(client);
		const pr = makeQueuedPr("123");
		client.setMergeability(pr.repoOwner, pr.repoName, pr.number, makeMergeability({ state: "blocked" }));
		await queue.enqueue(makeBundleFor(pr));
		await queue.dequeueNext();

		const { status, body } = await post(pullRequestReviewEventPayload("octocat", "hello-world", "submitted", "changes_requested"), "pull_request_review");

		expect(status).toBe(200);
		expect(body).toEqual({ ignored: true });
		expect((await queue.getEntry(makeBundleFor(pr).id))?.status).toBe("conflict");
	});

	it("clears a matching \"conflict\" queue entry when a review is approved, without merging when autoMergeOnAccept is off", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-webhook-"));
		const client = new StubGitHubClient();
		const { queue } = await setup(client);
		const pr = makeQueuedPr("123");
		client.setMergeability(pr.repoOwner, pr.repoName, pr.number, makeMergeability({ state: "blocked" }));
		await queue.enqueue(makeBundleFor(pr));
		const blocked = await queue.dequeueNext();
		expect(blocked?.status).toBe("conflict");
		expect(blocked?.conflict?.kind).toBe("blocked");

		client.setMergeability(pr.repoOwner, pr.repoName, pr.number, makeMergeability({ state: "clean" }));
		const { status } = await post(pullRequestReviewEventPayload("octocat", "hello-world", "submitted", "approved"), "pull_request_review");

		expect(status).toBe(202);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect((await queue.getEntry(makeBundleFor(pr).id))?.status).toBe("queued");
		expect(client.mergedPrs).toEqual([]);
	});

	it("also lands the bundle when a review is approved and autoMergeOnAccept is on", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-webhook-"));
		const client = new StubGitHubClient();
		const { refreshDeps, queue } = await setup(client);
		refreshDeps.accountState.current = {
			...refreshDeps.accountState.current,
			repos: refreshDeps.accountState.current.repos.map((r) => ({ ...r, autoMergeOnAccept: true })),
		};
		const pr = makeQueuedPr("123");
		client.setMergeability(pr.repoOwner, pr.repoName, pr.number, makeMergeability({ state: "blocked" }));
		await queue.enqueue(makeBundleFor(pr));
		const blocked = await queue.dequeueNext();
		expect(blocked?.status).toBe("conflict");

		client.setMergeability(pr.repoOwner, pr.repoName, pr.number, makeMergeability({ state: "clean" }));
		const { status } = await post(pullRequestReviewEventPayload("octocat", "hello-world", "submitted", "approved"), "pull_request_review");

		expect(status).toBe(202);
		await waitForEntryStatus(queue, makeBundleFor(pr).id, "landed");
		expect(client.mergedPrs).toEqual([`${pr.repoOwner}/${pr.repoName}/${pr.number}`]);
	});

	it("is a no-op when an approved review's PR has no matching conflict entry", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-webhook-"));
		const client = new StubGitHubClient();
		const { queue } = await setup(client);

		const { status } = await post(pullRequestReviewEventPayload("octocat", "hello-world", "submitted", "approved"), "pull_request_review");

		expect(status).toBe(202);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(await queue.listEntries()).toHaveLength(0);
	});

	function pullRequestClosedPayload(owner: string, repo: string, merged: boolean, prId = 123, installationId = BINDING.installationId): unknown {
		return {
			action: "closed",
			repository: { owner: { login: owner }, name: repo },
			pull_request: { id: prId, merged },
			installation: { id: installationId },
		};
	}

	it("lands a queued bundle whose only PR was merged directly on GitHub", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-webhook-"));
		const client = new StubGitHubClient();
		const { queue } = await setup(client);
		const pr = makeQueuedPr("123");
		await queue.enqueue(makeBundleFor(pr));

		const { status } = await post(pullRequestClosedPayload("octocat", "hello-world", true, 123), "pull_request");

		expect(status).toBe(202);
		await waitForEntryStatus(queue, makeBundleFor(pr).id, "landed");
		expect(client.mergedPrs).toEqual([]); // GitHub already merged it; Quire must not merge again
	});

	it("closes a queued bundle whose only PR was closed on GitHub without merging", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-webhook-"));
		const client = new StubGitHubClient();
		const { queue } = await setup(client);
		const pr = makeQueuedPr("123");
		await queue.enqueue(makeBundleFor(pr));

		const { status } = await post(pullRequestClosedPayload("octocat", "hello-world", false, 123), "pull_request");

		expect(status).toBe(202);
		await new Promise((resolve) => setTimeout(resolve, 50));
		const entry = await queue.getEntry(makeBundleFor(pr).id);
		expect(entry?.status).toBe("closed");
		expect(entry?.closedAt).toEqual(expect.any(String));
		expect(client.mergedPrs).toEqual([]);
	});

	it("clears a matching \"conflict\" queue entry to \"queued\" on a manual merge, without draining the rest when autoMergeOnAccept is off", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-webhook-"));
		const client = new StubGitHubClient();
		const { queue } = await setup(client);
		const pr1 = makeQueuedPr("123");
		const pr2 = { ...makeQueuedPr("456"), number: 2 };
		const pr3 = { ...makeQueuedPr("789"), number: 3 };
		client.setMergeability(pr2.repoOwner, pr2.repoName, pr2.number, makeMergeability({ state: "blocked" }));
		const bundle: Bundle = {
			id: "bundle-123",
			direction: pr1.declaredDirection,
			directionInferred: pr1.directionInferred,
			effectSummary: "adds OTP-based login",
			members: [pr1, pr2, pr3],
		};
		await queue.enqueue(bundle);
		const blocked = await queue.dequeueNext(); // merges pr1, blocks (conflict) on pr2; pr3 never attempted
		expect(blocked?.status).toBe("conflict");
		expect(blocked?.conflict?.prId).toBe("456");

		const { status } = await post(pullRequestClosedPayload("octocat", "hello-world", true, 456), "pull_request");

		expect(status).toBe(202);
		await new Promise((resolve) => setTimeout(resolve, 50));
		const entry = await queue.getEntry("bundle-123");
		expect(entry?.status).toBe("queued");
		expect(entry?.mergedPrIds.slice().sort()).toEqual(["123", "456"]);
		expect(client.mergedPrs).toEqual([`${pr1.repoOwner}/${pr1.repoName}/${pr1.number}`]); // pr2 not re-merged
	});

	it("also drains the rest of the bundle on a manual merge when autoMergeOnAccept is on", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-webhook-"));
		const client = new StubGitHubClient();
		const { refreshDeps, queue } = await setup(client);
		refreshDeps.accountState.current = {
			...refreshDeps.accountState.current,
			repos: refreshDeps.accountState.current.repos.map((r) => ({ ...r, autoMergeOnAccept: true })),
		};
		const pr1 = makeQueuedPr("123");
		const pr2 = { ...makeQueuedPr("456"), number: 2 };
		const pr3 = { ...makeQueuedPr("789"), number: 3 };
		client.setMergeability(pr2.repoOwner, pr2.repoName, pr2.number, makeMergeability({ state: "blocked" }));
		const bundle: Bundle = {
			id: "bundle-123",
			direction: pr1.declaredDirection,
			directionInferred: pr1.directionInferred,
			effectSummary: "adds OTP-based login",
			members: [pr1, pr2, pr3],
		};
		await queue.enqueue(bundle);
		const blocked = await queue.dequeueNext(); // merges pr1, blocks (conflict) on pr2; pr3 never attempted
		expect(blocked?.status).toBe("conflict");

		const { status } = await post(pullRequestClosedPayload("octocat", "hello-world", true, 456), "pull_request");

		expect(status).toBe(202);
		await waitForEntryStatus(queue, "bundle-123", "landed"); // dequeueNext continued and landed pr3 too
		expect(client.mergedPrs.sort()).toEqual(
			[`${pr1.repoOwner}/${pr1.repoName}/${pr1.number}`, `${pr3.repoOwner}/${pr3.repoName}/${pr3.number}`].sort(),
		);
	});

	it("is a no-op on the queue when a manually-merged PR has no matching queue entry", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-webhook-"));
		const client = new StubGitHubClient();
		const { queue } = await setup(client);

		const { status } = await post(pullRequestClosedPayload("octocat", "hello-world", true, 123), "pull_request");

		expect(status).toBe(202);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(await queue.listEntries()).toHaveLength(0);
	});
});
