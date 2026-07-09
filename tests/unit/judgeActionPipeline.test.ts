import { describe, it, expect, afterEach, jest } from "@jest/globals";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MergeQueue } from "../../src/engine/queue/mergeQueue.js";
import { StubGitHubClient } from "../../src/engine/github/stubClient.js";
import { LlmProviderHolder } from "../../src/engine/drift/effectList/providerHolder.js";
import { StubLlmProvider } from "../../src/engine/drift/effectList/stubProvider.js";
import { DecidedPrStore } from "../../src/engine/queue/decidedPrStore.js";
import { JudgeActionStore } from "../../src/engine/judge/judgeActionStore.js";
import {
	attemptAutoAction,
	handleCheckSuiteForVerification,
	sweepExpiredVerifications,
} from "../../src/engine/judge/actionPipeline.js";
import type { ActionPipelineDeps } from "../../src/engine/judge/actionPipeline.js";
import type { Bundle, PullRequest, ReviewCard } from "../../src/engine/types/core.js";
import type { JudgeVerdict } from "../../src/engine/types/judge.js";
import type { MergeabilityResult } from "../../src/engine/types/mergeability.js";
import type { SlackEscalationMessage, SlackNotifier, SlackOutcomeMessage, SlackShadowPredictionMessage } from "../../src/interface/notify/slack.js";

function makePr(overrides: Partial<PullRequest> = {}): PullRequest {
	return {
		id: "pr-1",
		repoOwner: "org",
		repoName: "repo",
		number: 1,
		headSha: "head-sha",
		declaredDirection: "add passwordless auth",
		directionInferred: false,
		diff: { raw: "", hunks: [] },
		filesTouched: ["src/auth.ts"],
		symbolsTouched: [],
		testNamesChanged: [],
		ciStatus: "success",
		...overrides,
	};
}

function makeBundle(id: string, members: ReadonlyArray<PullRequest>): Bundle {
	return {
		id,
		direction: "add passwordless auth",
		directionInferred: false,
		effectSummary: "adds OTP-based login",
		members,
	};
}

function makeCard(bundleId: string, overrides: Partial<ReviewCard> = {}): ReviewCard {
	return {
		bundleId,
		directionSummary: "add passwordless auth",
		directionInferred: false,
		repoOwner: "org",
		repoName: "repo",
		blastRadius: 1,
		flags: [],
		drift: { status: "clean" },
		residualDisclosure: "x",
		specConformance: { status: "clean" },
		specConformanceDisclosure: "",
		inputsHash: `hash-${bundleId}`,
		memberCount: 1,
		requiresAcceptConfirmation: false,
		...overrides,
	};
}

function makeVerdict(overrides: Partial<JudgeVerdict> = {}): JudgeVerdict {
	return {
		gesture: "accept",
		confidence: 0.95,
		criteria: { direction: 0.9, drift: 0.9, blastRadius: 0.9, reversibility: 0.9, precedent: 0.9 },
		riskFlags: [],
		rationale: "clean extension of an accepted precedent",
		precedentIds: [],
		modelId: "fake:judge-model",
		...overrides,
	};
}

class RecordingSlack implements SlackNotifier {
	readonly outcomes: SlackOutcomeMessage[] = [];
	readonly escalations: SlackEscalationMessage[] = [];
	readonly shadowPredictions: SlackShadowPredictionMessage[] = [];

	async notifyOutcome(message: SlackOutcomeMessage): Promise<void> {
		this.outcomes.push(message);
	}

	async notifyEscalation(message: SlackEscalationMessage): Promise<void> {
		this.escalations.push(message);
	}

	async notifyShadowPrediction(message: SlackShadowPredictionMessage): Promise<void> {
		this.shadowPredictions.push(message);
	}
}

function makeMergeability(overrides: Partial<MergeabilityResult> = {}): MergeabilityResult {
	return {
		state: "clean",
		isFork: false,
		merged: false,
		headBranch: "feature",
		headSha: "head-sha",
		baseBranch: "main",
		baseSha: "base-sha",
		...overrides,
	};
}

describe("judge action pipeline", () => {
	let dir: string;

	afterEach(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	async function setup(): Promise<{ github: StubGitHubClient; deps: ActionPipelineDeps; slack: RecordingSlack }> {
		dir = await mkdtemp(join(tmpdir(), "quire-judge-action-"));
		const github = new StubGitHubClient();
		const queue = new MergeQueue(join(dir, "queue.json"), github, new LlmProviderHolder(new StubLlmProvider()), join(dir, "conflict.ndjson"));
		await queue.load();
		const decidedStore = new DecidedPrStore(join(dir, "decided.json"));
		await decidedStore.load();
		const slack = new RecordingSlack();
		const deps: ActionPipelineDeps = {
			queue,
			actionStore: new JudgeActionStore(),
			slack,
			github,
			decidedStore,
			bundles: new Map(),
			cards: new Map(),
			verifyTimeoutMs: 30 * 60 * 1000,
		};
		return { github, deps, slack };
	}

	describe("attemptAutoAction — accept", () => {
		it("merges, lands, and moves to awaitingVerification with the captured member SHA", async () => {
			const { github, deps } = await setup();
			const pr = makePr();
			const bundle = makeBundle("bundle-1", [pr]);
			const card = makeCard("bundle-1");
			deps.bundles.set(bundle.id, bundle);
			deps.cards.set(bundle.id, card);
			github.setMergeCommitSha(pr.repoOwner, pr.repoName, pr.number, "merge-sha-1");

			await attemptAutoAction(bundle, card, makeVerdict(), deps);

			const record = deps.actionStore.find(bundle.id, card.inputsHash);
			expect(record?.status).toBe("awaitingVerification");
			expect(record?.members).toEqual([{ prId: pr.id, repoOwner: pr.repoOwner, repoName: pr.repoName, number: pr.number, sha: "merge-sha-1" }]);
			expect(deps.bundles.has(bundle.id)).toBe(false);
			expect(deps.cards.has(bundle.id)).toBe(false);
		});

		it("is idempotent: a second attempt for the same (bundleId, inputsHash) never merges twice", async () => {
			const { github, deps } = await setup();
			const pr = makePr();
			const bundle = makeBundle("bundle-1", [pr]);
			const card = makeCard("bundle-1");
			deps.bundles.set(bundle.id, bundle);
			deps.cards.set(bundle.id, card);

			await attemptAutoAction(bundle, card, makeVerdict(), deps);
			await attemptAutoAction(bundle, card, makeVerdict(), deps);

			expect(github.mergedPrs).toEqual(["org/repo/1"]);
		});

		it("escalates without merging when the PR is blocked (not a merge conflict, no resolution attempted)", async () => {
			const { github, deps, slack } = await setup();
			const pr = makePr();
			const bundle = makeBundle("bundle-1", [pr]);
			const card = makeCard("bundle-1");
			deps.bundles.set(bundle.id, bundle);
			deps.cards.set(bundle.id, card);
			github.setMergeability(pr.repoOwner, pr.repoName, pr.number, makeMergeability({ state: "blocked" }));

			await attemptAutoAction(bundle, card, makeVerdict(), deps);

			const record = deps.actionStore.find(bundle.id, card.inputsHash);
			expect(record?.status).toBe("escalated");
			expect(record?.terminalReason).toMatch(/blocked/);
			expect(slack.escalations).toHaveLength(1);
			expect(github.mergedPrs).toEqual([]);
		});

		it("escalates rather than declaring success when a member landed via the alreadyMerged path (no fresh SHA)", async () => {
			const { github, deps, slack } = await setup();
			const pr = makePr();
			const bundle = makeBundle("bundle-1", [pr]);
			const card = makeCard("bundle-1");
			deps.bundles.set(bundle.id, bundle);
			deps.cards.set(bundle.id, card);
			github.setMergeability(pr.repoOwner, pr.repoName, pr.number, makeMergeability({ merged: true }));

			await attemptAutoAction(bundle, card, makeVerdict(), deps);

			const record = deps.actionStore.find(bundle.id, card.inputsHash);
			expect(record?.status).toBe("escalated");
			expect(record?.terminalReason).toMatch(/no merge-commit SHA was captured/);
			expect(slack.escalations).toHaveLength(1);
		});
	});

	describe("attemptAutoAction — reject", () => {
		it("closes every member PR, records the reject, and notifies Slack", async () => {
			const { github, deps, slack } = await setup();
			const pr = makePr();
			const bundle = makeBundle("bundle-1", [pr]);
			const card = makeCard("bundle-1");
			deps.bundles.set(bundle.id, bundle);
			deps.cards.set(bundle.id, card);

			await attemptAutoAction(bundle, card, makeVerdict({ gesture: "reject" }), deps);

			expect(github.closedPrs).toEqual(["org/repo/1"]);
			expect(deps.decidedStore.isDecided(pr.id)).toBe(true);
			expect(deps.bundles.has(bundle.id)).toBe(false);
			const record = deps.actionStore.find(bundle.id, card.inputsHash);
			expect(record?.status).toBe("rejected");
			expect(slack.outcomes).toHaveLength(1);
			expect(slack.outcomes[0]?.kind).toBe("auto-rejected");
		});

		it("is idempotent: a second attempt never closes the PRs twice", async () => {
			const { github, deps } = await setup();
			const pr = makePr();
			const bundle = makeBundle("bundle-1", [pr]);
			const card = makeCard("bundle-1");

			await attemptAutoAction(bundle, card, makeVerdict({ gesture: "reject" }), deps);
			await attemptAutoAction(bundle, card, makeVerdict({ gesture: "reject" }), deps);

			expect(github.closedPrs).toEqual(["org/repo/1"]);
		});
	});

	describe("handleCheckSuiteForVerification", () => {
		async function landBundle(deps: ActionPipelineDeps, github: StubGitHubClient, pr: PullRequest, bundle: Bundle, card: ReviewCard, sha: string): Promise<void> {
			github.setMergeCommitSha(pr.repoOwner, pr.repoName, pr.number, sha);
			await attemptAutoAction(bundle, card, makeVerdict(), deps);
		}

		it("finalizes as verified when CI succeeds and no health check is configured", async () => {
			const { github, deps, slack } = await setup();
			const pr = makePr();
			const bundle = makeBundle("bundle-1", [pr]);
			const card = makeCard("bundle-1");
			await landBundle(deps, github, pr, bundle, card, "sha-1");

			await handleCheckSuiteForVerification("org", "repo", "sha-1", "success", deps);

			expect(deps.actionStore.find(bundle.id, card.inputsHash)?.status).toBe("verified");
			expect(slack.outcomes[0]?.kind).toBe("auto-merged-and-verified");
		});

		it("reverts when CI fails", async () => {
			const { github, deps, slack } = await setup();
			const pr = makePr();
			const bundle = makeBundle("bundle-1", [pr]);
			const card = makeCard("bundle-1");
			await landBundle(deps, github, pr, bundle, card, "sha-1");

			await handleCheckSuiteForVerification("org", "repo", "sha-1", "failure", deps);

			const record = deps.actionStore.find(bundle.id, card.inputsHash);
			expect(record?.status).toBe("reverted");
			expect(github.revertedPrs).toEqual(["org/repo/1"]);
			expect(slack.outcomes.some((o) => o.kind === "reverted")).toBe(true);
			expect(slack.escalations.length).toBeGreaterThan(0);
		});

		it("does not finalize on an ambiguous conclusion (still inconclusive, waits for a later delivery)", async () => {
			const { github, deps } = await setup();
			const pr = makePr();
			const bundle = makeBundle("bundle-1", [pr]);
			const card = makeCard("bundle-1");
			await landBundle(deps, github, pr, bundle, card, "sha-1");

			await handleCheckSuiteForVerification("org", "repo", "sha-1", "neutral", deps);

			expect(deps.actionStore.find(bundle.id, card.inputsHash)?.status).toBe("awaitingVerification");
		});

		it("is a no-op for an unrelated (repo, sha) pair", async () => {
			const { github, deps } = await setup();
			const pr = makePr();
			const bundle = makeBundle("bundle-1", [pr]);
			const card = makeCard("bundle-1");
			await landBundle(deps, github, pr, bundle, card, "sha-1");

			await handleCheckSuiteForVerification("someone-else", "other-repo", "unrelated-sha", "success", deps);

			expect(deps.actionStore.find(bundle.id, card.inputsHash)?.status).toBe("awaitingVerification");
		});

		it("only finalizes once every member of a multi-PR bundle has resolved", async () => {
			const { github, deps, slack } = await setup();
			const prA = makePr({ id: "pr-a", number: 1 });
			const prB = makePr({ id: "pr-b", number: 2 });
			const bundle = makeBundle("bundle-1", [prA, prB]);
			const card = makeCard("bundle-1");
			github.setMergeCommitSha(prA.repoOwner, prA.repoName, prA.number, "sha-a");
			github.setMergeCommitSha(prB.repoOwner, prB.repoName, prB.number, "sha-b");

			await attemptAutoAction(bundle, card, makeVerdict(), deps);
			expect(deps.actionStore.find(bundle.id, card.inputsHash)?.status).toBe("awaitingVerification");

			await handleCheckSuiteForVerification("org", "repo", "sha-a", "success", deps);
			expect(deps.actionStore.find(bundle.id, card.inputsHash)?.status).toBe("awaitingVerification");
			expect(slack.outcomes).toHaveLength(0);

			await handleCheckSuiteForVerification("org", "repo", "sha-b", "success", deps);
			expect(deps.actionStore.find(bundle.id, card.inputsHash)?.status).toBe("verified");
			expect(slack.outcomes).toHaveLength(1);
		});

		describe("with a health check configured", () => {
			afterEach(() => {
				jest.restoreAllMocks();
			});

			it("finalizes as verified when the health check reports healthy", async () => {
				const { github, deps } = await setup();
				deps.healthCheckUrl = "https://example.com/health";
				global.fetch = jest.fn(async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;
				const pr = makePr();
				const bundle = makeBundle("bundle-1", [pr]);
				const card = makeCard("bundle-1");
				await landBundle(deps, github, pr, bundle, card, "sha-1");

				await handleCheckSuiteForVerification("org", "repo", "sha-1", "success", deps);

				expect(deps.actionStore.find(bundle.id, card.inputsHash)?.status).toBe("verified");
			});

			it("reverts when the health check reports unhealthy (a real, reachable bad response)", async () => {
				const { github, deps, slack } = await setup();
				deps.healthCheckUrl = "https://example.com/health";
				deps.verifyTimeoutMs = 1000;
				global.fetch = jest.fn(async () => ({ ok: false, status: 503 })) as unknown as typeof fetch;
				const pr = makePr();
				const bundle = makeBundle("bundle-1", [pr]);
				const card = makeCard("bundle-1");
				await landBundle(deps, github, pr, bundle, card, "sha-1");

				await handleCheckSuiteForVerification("org", "repo", "sha-1", "success", deps);

				const record = deps.actionStore.find(bundle.id, card.inputsHash);
				expect(record?.status).toBe("reverted");
				expect(record?.terminalReason).toMatch(/unhealthy/);
				expect(slack.outcomes.some((o) => o.kind === "reverted")).toBe(true);
			});

			it("escalates as inconclusive (never reverts) when the health check is unreachable", async () => {
				const { github, deps, slack } = await setup();
				deps.healthCheckUrl = "https://example.com/health";
				global.fetch = jest.fn(async () => {
					throw new Error("connect ECONNREFUSED");
				}) as unknown as typeof fetch;
				const pr = makePr();
				const bundle = makeBundle("bundle-1", [pr]);
				const card = makeCard("bundle-1");
				await landBundle(deps, github, pr, bundle, card, "sha-1");

				await handleCheckSuiteForVerification("org", "repo", "sha-1", "success", deps);

				const record = deps.actionStore.find(bundle.id, card.inputsHash);
				expect(record?.status).toBe("escalated");
				expect(record?.terminalReason).toMatch(/unreachable/);
				expect(github.revertedPrs).toEqual([]);
				expect(slack.escalations.length).toBeGreaterThan(0);
			});
		});
	});

	describe("sweepExpiredVerifications", () => {
		it("escalates a bundle whose deadline has passed as inconclusive, never as success or failure", async () => {
			const { github, deps, slack } = await setup();
			const pr = makePr();
			const bundle = makeBundle("bundle-1", [pr]);
			const card = makeCard("bundle-1");
			deps.verifyTimeoutMs = -1; // deadline already in the past the moment it's set
			await attemptAutoAction(bundle, card, makeVerdict(), deps);
			expect(deps.actionStore.find(bundle.id, card.inputsHash)?.status).toBe("awaitingVerification");

			await sweepExpiredVerifications(deps);

			const record = deps.actionStore.find(bundle.id, card.inputsHash);
			expect(record?.status).toBe("escalated");
			expect(record?.terminalReason).toMatch(/did not complete within the timeout/);
			expect(github.revertedPrs).toEqual([]);
			expect(slack.escalations.length).toBeGreaterThan(0);
			void github;
		});

		it("leaves a bundle with a future deadline untouched", async () => {
			const { github, deps } = await setup();
			const pr = makePr();
			const bundle = makeBundle("bundle-1", [pr]);
			const card = makeCard("bundle-1");
			deps.verifyTimeoutMs = 30 * 60 * 1000;
			await attemptAutoAction(bundle, card, makeVerdict(), deps);

			await sweepExpiredVerifications(deps);

			expect(deps.actionStore.find(bundle.id, card.inputsHash)?.status).toBe("awaitingVerification");
			void github;
		});
	});
});
