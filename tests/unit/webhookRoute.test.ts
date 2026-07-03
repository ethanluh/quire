import { describe, it, expect, afterEach } from "@jest/globals";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import type { Server } from "node:http";
import { webhookRouter } from "../../src/interface/server/routes/webhook.js";
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
import type { Bundle, PullRequest } from "../../src/engine/types/core.js";
import type { ConflictTrees, MergeabilityResult, TreeEntry } from "../../src/engine/types/mergeability.js";

const CALLBACK_BASE_URL = "https://quire.example.com/callbacks/action-resolution";

const PIPELINE_CONFIG: PipelineConfig = {
	gate: { criteria: [{ name: "buildFailure", mode: "enforce" }] },
	bundle: { similarityThreshold: 0.75 },
};

const ACCOUNT: InstallationBinding = {
	installationId: 1,
	accountLogin: "octocat",
	accountType: "User",
	boundAt: "2026-06-30T00:00:00.000Z",
	selectedRepo: { owner: "octocat", name: "hello-world" },
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
		filesTouched: ["src/auth.ts"],
		...overrides,
	};
}

function pullRequestEventPayload(owner: string, repo: string, action: string, prId = 123, installationId = ACCOUNT.installationId): unknown {
	return {
		action,
		repository: { owner: { login: owner }, name: repo },
		pull_request: { id: prId },
		installation: { id: installationId },
	};
}

function workflowRunEventPayload(
	owner: string,
	repo: string,
	runId: number,
	status: string,
	conclusion: string | null,
	installationId = ACCOUNT.installationId,
): unknown {
	return {
		action: status,
		repository: { owner: { login: owner }, name: repo },
		workflow_run: { id: runId, status, conclusion },
		installation: { id: installationId },
	};
}

function makeConflictPr(overrides: Partial<PullRequest> = {}): PullRequest {
	return {
		id: "pr-1",
		repoOwner: "octocat",
		repoName: "hello-world",
		number: 1,
		headSha: "head-sha",
		declaredDirection: "add passwordless auth",
		diff: { raw: "", hunks: [] },
		filesTouched: ["src/auth.ts"],
		symbolsTouched: [],
		testNamesChanged: [],
		ciStatus: "success",
		...overrides,
	};
}

function makeBundle(id: string, members: ReadonlyArray<PullRequest>): Bundle {
	return { id, direction: "add passwordless auth", effectSummary: "adds OTP-based login", members };
}

function makeMergeability(overrides: Partial<MergeabilityResult> = {}): MergeabilityResult {
	return {
		state: "dirty",
		isFork: false,
		merged: false,
		headBranch: "feature",
		headSha: "head-sha",
		baseBranch: "main",
		baseSha: "base-tip-sha",
		...overrides,
	};
}

function blob(sha: string, mode = "100644"): TreeEntry {
	return { type: "blob", mode, sha };
}

function conflictTrees(): ConflictTrees {
	return {
		mergeBaseSha: "merge-base-sha",
		baseSha: "base-tip-sha",
		headSha: "head-sha",
		mergeBaseTree: new Map([["src/auth.ts", blob("base-sha")]]),
		baseTree: new Map([["src/auth.ts", blob("theirs-sha")]]),
		headTree: new Map([["src/auth.ts", blob("ours-sha")]]),
	};
}

describe("webhookRouter", () => {
	let dir: string;
	let server: Server;

	afterEach(async () => {
		if (server) await new Promise((resolve) => server.close(resolve));
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	async function setup(client: StubGitHubClient = new StubGitHubClient(), provider = new StubLlmProvider()): Promise<{ refreshDeps: RefreshDeps; queue: MergeQueue }> {
		const refreshDeps: RefreshDeps = {
			accountState: createAccountState(ACCOUNT),
			accountPath: join(dir, "installation.json"),
			preferencesPath: join(dir, "preferences.json"),
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
		};
		const conflictLogPath = join(dir, "conflict.ndjson");
		const queue = new MergeQueue(join(dir, "queue.json"), client, CALLBACK_BASE_URL, conflictLogPath);
		await queue.load();
		const app = express();
		app.use(express.raw({ type: "application/json" }));
		app.use(
			webhookRouter((installationId) =>
				installationId === ACCOUNT.installationId ? { refreshDeps, queue, conflictLogPath } : undefined,
			),
		);
		server = app.listen(0);
		return { refreshDeps, queue };
	}

	async function post(payload: unknown, event: string): Promise<{ status: number; body: unknown }> {
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("no address");
		const res = await fetch(`http://127.0.0.1:${address.port}/`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-GitHub-Event": event },
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

	it("clears the decided-PR entry on a synchronize event before refreshing, so a reworked PR reappears", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-webhook-"));
		const client = new StubGitHubClient();
		client.addFixture("octocat", "hello-world", makePrFixture({ id: "123" }));
		const provider = new StubLlmProvider();
		provider.queueCompletion('["adds OTP login"]');
		provider.queueCompletion(JSON.stringify([{ clause: "adds OTP login", matchedDirection: true }]));
		const { refreshDeps } = await setup(client, provider);
		await refreshDeps.decidedStore.markDecided(["123"], "reject");

		const { status } = await post(pullRequestEventPayload("octocat", "hello-world", "synchronize", 123), "pull_request");

		expect(status).toBe(202);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(refreshDeps.decidedStore.isDecided("123")).toBe(false);
		expect(refreshDeps.state.bundles.size).toBe(1);
	});

	describe("workflow_run events", () => {
		// Dispatches a real conflict through the queue so the entry ends up "resolving" with a
		// genuine workflowRunId, mirroring how MergeQueue.dequeueNext() actually produces one.
		async function setupResolving(queue: MergeQueue, client: StubGitHubClient, workflowRunId: number): Promise<PullRequest> {
			const pr = makeConflictPr();
			client.setBlobContent("base-sha", "line1\nline2");
			client.setBlobContent("ours-sha", "line1-ours\nline2");
			client.setBlobContent("theirs-sha", "line1-theirs\nline2");
			client.setConflictTrees(pr.repoOwner, pr.repoName, pr.number, conflictTrees());
			client.setMergeability(pr.repoOwner, pr.repoName, pr.number, makeMergeability());
			client.dispatchConflictResolutionResult = { workflowRunId };
			await queue.enqueue(makeBundle("bundle-1", [pr]));
			const resolving = await queue.dequeueNext();
			expect(resolving?.status).toBe("resolving");
			return pr;
		}

		it("ignores a completed workflow_run with a successful conclusion", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-webhook-"));
			const client = new StubGitHubClient();
			const { queue } = await setup(client);
			await setupResolving(queue, client, 555);

			const { status, body } = await post(workflowRunEventPayload("octocat", "hello-world", 555, "completed", "success"), "workflow_run");

			expect(status).toBe(200);
			expect(body).toEqual({ ignored: true });
			expect((await queue.getEntry("bundle-1"))?.status).toBe("resolving");
		});

		it("ignores a workflow_run that hasn't completed yet", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-webhook-"));
			const client = new StubGitHubClient();
			const { queue } = await setup(client);
			await setupResolving(queue, client, 555);

			const { status, body } = await post(workflowRunEventPayload("octocat", "hello-world", 555, "in_progress", null), "workflow_run");

			expect(status).toBe(200);
			expect(body).toEqual({ ignored: true });
			expect((await queue.getEntry("bundle-1"))?.status).toBe("resolving");
		});

		it("ignores a workflow_run for a repo that isn't currently selected", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-webhook-"));
			const client = new StubGitHubClient();
			const { queue } = await setup(client);
			await setupResolving(queue, client, 555);

			const { status, body } = await post(workflowRunEventPayload("octocat", "other-repo", 555, "completed", "failure"), "workflow_run");

			expect(status).toBe(200);
			expect(body).toEqual({ ignored: true });
			expect((await queue.getEntry("bundle-1"))?.status).toBe("resolving");
		});

		it("ignores a completed workflow_run whose run id doesn't match any resolving entry", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-webhook-"));
			const client = new StubGitHubClient();
			const { queue } = await setup(client);
			await setupResolving(queue, client, 555);

			const { status, body } = await post(workflowRunEventPayload("octocat", "hello-world", 999, "completed", "failure"), "workflow_run");

			expect(status).toBe(200);
			expect(body).toEqual({ ignored: true });
			expect((await queue.getEntry("bundle-1"))?.status).toBe("resolving");
		});

		it("marks the matching resolving entry as conflict when the workflow run concludes without success", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-webhook-"));
			const client = new StubGitHubClient();
			const { queue } = await setup(client);
			const pr = await setupResolving(queue, client, 555);

			const { status, body } = await post(workflowRunEventPayload("octocat", "hello-world", 555, "completed", "failure"), "workflow_run");

			expect(status).toBe(200);
			expect(body).toEqual({ acknowledged: true });
			const entry = await queue.getEntry("bundle-1");
			expect(entry?.status).toBe("conflict");
			expect(entry?.conflict).toMatchObject({ prId: pr.id, reason: expect.stringContaining("failure") });
		});
	});
});
