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
import { StubLlmProvider } from "../../src/engine/drift/effectList/stubProvider.js";
import { StubStaticAnalyzer } from "../mocks/staticAnalyzer.js";
import type { InstallationBinding } from "../../src/engine/github/installation.js";
import type { PipelineConfig } from "../../src/engine/pipeline/pipeline.js";
import { MergeQueue } from "../../src/engine/queue/mergeQueue.js";
import { LlmProviderHolder } from "../../src/engine/drift/effectList/providerHolder.js";
import { JudgeActionStore } from "../../src/engine/judge/judgeActionStore.js";
import { attemptAutoAction } from "../../src/engine/judge/actionPipeline.js";
import type { ActionPipelineDeps } from "../../src/engine/judge/actionPipeline.js";
import type { Bundle, PullRequest, ReviewCard } from "../../src/engine/types/core.js";
import type { JudgeVerdict } from "../../src/engine/types/judge.js";
import type { SlackEscalationMessage, SlackNotifier, SlackOutcomeMessage, SlackShadowPredictionMessage } from "../../src/interface/notify/slack.js";

const PIPELINE_CONFIG: PipelineConfig = {
	gate: { criteria: [] },
	bundle: { similarityThreshold: 0.75 },
};

const BINDING: InstallationBinding = {
	installationId: 1,
	accountLogin: "octocat",
	accountType: "User",
	boundAt: "2026-06-30T00:00:00.000Z",
};

class RecordingSlack implements SlackNotifier {
	readonly outcomes: SlackOutcomeMessage[] = [];
	readonly escalations: SlackEscalationMessage[] = [];
	async notifyOutcome(message: SlackOutcomeMessage): Promise<void> {
		this.outcomes.push(message);
	}
	async notifyEscalation(message: SlackEscalationMessage): Promise<void> {
		this.escalations.push(message);
	}
	async notifyShadowPrediction(_message: SlackShadowPredictionMessage): Promise<void> {
		// Not exercised by these tests.
	}
}

function makePr(): PullRequest {
	return {
		id: "123",
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

function makeBundle(pr: PullRequest): Bundle {
	return { id: "bundle-123", direction: pr.declaredDirection, directionInferred: false, effectSummary: "adds OTP-based login", members: [pr] };
}

function makeCard(bundleId: string): ReviewCard {
	return {
		bundleId,
		directionSummary: "add passwordless auth",
		directionInferred: false,
		repoOwner: "octocat",
		repoName: "hello-world",
		blastRadius: 1,
		flags: [],
		drift: { status: "clean" },
		residualDisclosure: "x",
		specConformance: { status: "clean" },
		specConformanceDisclosure: "",
		inputsHash: "hash-1",
		memberCount: 1,
		requiresAcceptConfirmation: false,
	};
}

function makeVerdict(): JudgeVerdict {
	return {
		gesture: "accept",
		confidence: 0.95,
		criteria: { direction: 0.9, drift: 0.9, blastRadius: 0.9, reversibility: 0.9, precedent: 0.9 },
		riskFlags: [],
		rationale: "clean extension of an accepted precedent",
		precedentIds: [],
		modelId: "fake:judge-model",
	};
}

function checkSuiteEventPayload(owner: string, repo: string, action: string, conclusion: string | null, headSha: string, installationId = BINDING.installationId): unknown {
	return {
		action,
		check_suite: { conclusion, head_sha: headSha, pull_requests: [] },
		repository: { owner: { login: owner }, name: repo },
		installation: { id: installationId },
	};
}

describe("webhookRouter — judge verification via check_suite", () => {
	let dir: string;
	let server: Server;

	afterEach(async () => {
		if (server) await new Promise((resolve) => server.close(resolve));
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	async function setup(): Promise<{ actionDeps: ActionPipelineDeps; slack: RecordingSlack; github: StubGitHubClient }> {
		const github = new StubGitHubClient();
		const queue = new MergeQueue(join(dir, "queue.json"), github, new LlmProviderHolder(new StubLlmProvider()), join(dir, "conflict.ndjson"));
		await queue.load();
		const decidedStore = new DecidedPrStore(join(dir, "decided-prs.json"));
		await decidedStore.load();
		const slack = new RecordingSlack();
		const actionDeps: ActionPipelineDeps = {
			queue,
			actionStore: new JudgeActionStore(),
			slack,
			github,
			decidedStore,
			bundles: new Map(),
			cards: new Map(),
			verifyTimeoutMs: 30 * 60 * 1000,
		};

		const refreshDeps: RefreshDeps = {
			accountState: createAccountState({
				installations: [BINDING],
				repos: [{ owner: "octocat", name: "hello-world", installationId: BINDING.installationId, addedAt: new Date(0).toISOString(), addedBy: "test-user" }],
			}),
			accountPath: join(dir, "installation.json"),
			clientHolder: new GitHubClientHolder(github),
			appConfig: { appId: "1", privateKey: "unused" },
			decidedStore,
			state: createServerState(),
			pipelineDeps: { config: PIPELINE_CONFIG, provider: new StubLlmProvider(), analyzer: new StubStaticAnalyzer(), auditStore: new AuditStore(), prCache: new PrEffectCache() },
			queue,
		};

		const app = express();
		app.use(express.raw({ type: "application/json" }));
		app.use(webhookRouter((installationId) => (installationId === BINDING.installationId ? { refreshDeps, judgeActionDeps: actionDeps } : undefined)));
		server = app.listen(0);
		return { actionDeps, slack, github };
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

	it("finalizes a bundle awaiting verification as verified when the real webhook route delivers a matching successful check_suite", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-webhook-judge-"));
		const { actionDeps, slack, github } = await setup();
		const pr = makePr();
		const bundle = makeBundle(pr);
		const card = makeCard(bundle.id);
		github.setMergeCommitSha(pr.repoOwner, pr.repoName, pr.number, "merge-sha-xyz");
		await attemptAutoAction(bundle, card, makeVerdict(), actionDeps);
		expect(actionDeps.actionStore.find(bundle.id, card.inputsHash)?.status).toBe("awaitingVerification");

		const { status } = await post(checkSuiteEventPayload("octocat", "hello-world", "completed", "success", "merge-sha-xyz"), "check_suite");
		await new Promise((resolve) => setTimeout(resolve, 20)); // the route handles this async after responding

		expect(status).toBe(202);
		expect(actionDeps.actionStore.find(bundle.id, card.inputsHash)?.status).toBe("verified");
		expect(slack.outcomes[0]?.kind).toBe("auto-merged-and-verified");
	});

	it("reverts via the real webhook route when the delivered check_suite conclusion is a failure", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-webhook-judge-"));
		const { actionDeps, github } = await setup();
		const pr = makePr();
		const bundle = makeBundle(pr);
		const card = makeCard(bundle.id);
		github.setMergeCommitSha(pr.repoOwner, pr.repoName, pr.number, "merge-sha-xyz");
		await attemptAutoAction(bundle, card, makeVerdict(), actionDeps);

		const { status } = await post(checkSuiteEventPayload("octocat", "hello-world", "completed", "failure", "merge-sha-xyz"), "check_suite");
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(status).toBe(202);
		expect(actionDeps.actionStore.find(bundle.id, card.inputsHash)?.status).toBe("reverted");
		expect(github.revertedPrs).toEqual(["octocat/hello-world/1"]);
	});

	it("still responds 200/ignored for an unrelated repo's check_suite, exactly as with no judge configured", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-webhook-judge-"));
		await setup();

		const { status, body } = await post(checkSuiteEventPayload("someone-else", "other-repo", "completed", "failure", "sha-1", BINDING.installationId), "check_suite");

		// Not a watched repo for this installation — ignored before the judge branch is ever reached.
		expect(status).toBe(200);
		expect(body).toEqual({ ignored: true });
	});
});
