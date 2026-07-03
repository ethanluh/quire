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
		filesTouched: ["src/auth.ts"],
		...overrides,
	};
}

function pullRequestEventPayload(owner: string, repo: string, action: string, prId = 123): unknown {
	return {
		action,
		repository: { owner: { login: owner }, name: repo },
		pull_request: { id: prId },
	};
}

describe("webhookRouter", () => {
	let dir: string;
	let server: Server;

	afterEach(async () => {
		if (server) await new Promise((resolve) => server.close(resolve));
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	async function setup(client: StubGitHubClient = new StubGitHubClient(), provider = new StubLlmProvider()): Promise<{ refreshDeps: RefreshDeps }> {
		const refreshDeps: RefreshDeps = {
			accountState: createAccountState({
				installations: [BINDING],
				selectedRepo: { owner: "octocat", name: "hello-world", installationId: BINDING.installationId },
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
		};
		const app = express();
		app.use(express.raw({ type: "application/json" }));
		app.use(webhookRouter(refreshDeps));
		server = app.listen(0);
		return { refreshDeps };
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

	it("ignores non-pull_request events even when they look like a GitHub payload", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-webhook-"));
		await setup();

		const { status, body } = await post({ action: "completed" }, "workflow_run");

		expect(status).toBe(200);
		expect(body).toEqual({ ignored: true });
	});
});
