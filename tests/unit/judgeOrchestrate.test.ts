import { describe, it, expect, jest, afterEach } from "@jest/globals";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runJudgeForBundle } from "../../src/engine/judge/orchestrate.js";
import type { JudgeRunDeps } from "../../src/engine/judge/orchestrate.js";
import { JudgeVerdictStore } from "../../src/engine/judge/judgeVerdictStore.js";
import { JudgeActionStore } from "../../src/engine/judge/judgeActionStore.js";
import type { ActionPipelineDeps } from "../../src/engine/judge/actionPipeline.js";
import { NoopSlackNotifier } from "../../src/interface/notify/slack.js";
import type { SlackEscalationMessage, SlackNotifier, SlackOutcomeMessage, SlackShadowPredictionMessage } from "../../src/interface/notify/slack.js";
import { MergeQueue } from "../../src/engine/queue/mergeQueue.js";
import { StubGitHubClient } from "../../src/engine/github/stubClient.js";
import { LlmProviderHolder } from "../../src/engine/drift/effectList/providerHolder.js";
import { StubLlmProvider as DriftStubLlmProvider } from "../../src/engine/drift/effectList/stubProvider.js";
import { DecidedPrStore } from "../../src/engine/queue/decidedPrStore.js";
import type { Bundle, PullRequest, ReviewCard } from "../../src/engine/types/core.js";
import type { JudgeConstitution } from "../../src/engine/types/judge.js";
import type { InstrumentationSink, JudgeVerdictLog } from "../../src/engine/types/instrumentation.js";
import type { LlmCall, LlmCallOptions, LlmMessage, LlmProvider } from "../../src/engine/drift/effectList/provider.js";

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

let actionDepsDir: string;

afterEach(async () => {
	if (actionDepsDir) await rm(actionDepsDir, { recursive: true, force: true });
});

// A minimal but fully real ActionPipelineDeps (StubGitHubClient defaults to "clean"
// mergeability, so attemptAutoAction actually lands) — these tests are about proving
// orchestrate.ts routes to (or withholds from) attemptAutoAction correctly per mode/sampling,
// not about re-testing attemptAutoAction's own mechanics (judgeActionPipeline.test.ts already
// does that exhaustively).
async function makeFakeActionDeps(slack: SlackNotifier): Promise<ActionPipelineDeps> {
	actionDepsDir = await mkdtemp(join(tmpdir(), "quire-judge-orchestrate-"));
	const github = new StubGitHubClient();
	const queue = new MergeQueue(join(actionDepsDir, "queue.json"), github, new LlmProviderHolder(new DriftStubLlmProvider()), join(actionDepsDir, "conflict.ndjson"));
	await queue.load();
	const decidedStore = new DecidedPrStore(join(actionDepsDir, "decided.json"));
	await decidedStore.load();
	return {
		queue,
		actionStore: new JudgeActionStore(),
		slack,
		github,
		decidedStore,
		bundles: new Map(),
		cards: new Map(),
		verifyTimeoutMs: 30 * 60 * 1000,
	};
}

class FakeLlmProvider implements LlmProvider {
	private readonly queue: string[] = [];
	private readonly _calls: LlmCall[] = [];
	readonly supportsEmbeddings = false;
	readonly modelKey = "fake:judge-model";

	queueResponse(response: string): void {
		this.queue.push(response);
	}

	get calls(): ReadonlyArray<LlmCall> {
		return this._calls;
	}

	async complete(messages: ReadonlyArray<LlmMessage>, _opts?: LlmCallOptions): Promise<string> {
		const response = this.queue.shift() ?? "[]";
		this._calls.push({ messages, response });
		return response;
	}

	async embed(_text: string): Promise<ReadonlyArray<number>> {
		return [];
	}
}

function makePr(overrides: Partial<PullRequest> = {}): PullRequest {
	return {
		id: "pr-1",
		repoOwner: "org",
		repoName: "repo",
		number: 1,
		headSha: "sha-1",
		declaredDirection: "add passwordless auth",
		directionInferred: false,
		diff: { raw: "", hunks: [] },
		filesTouched: [],
		symbolsTouched: [],
		testNamesChanged: [],
		ciStatus: "success",
		...overrides,
	};
}

function makeBundle(overrides: Partial<Bundle> = {}): Bundle {
	return {
		id: "bundle-1",
		direction: "add passwordless auth",
		directionInferred: false,
		effectSummary: "adds OTP-based login",
		members: [makePr()],
		...overrides,
	};
}

function makeCard(overrides: Partial<ReviewCard> = {}): ReviewCard {
	return {
		bundleId: "bundle-1",
		directionSummary: "add passwordless auth",
		directionInferred: false,
		repoOwner: "org",
		repoName: "repo",
		blastRadius: 3,
		flags: [],
		drift: { status: "clean" },
		residualDisclosure: "x",
		specConformance: { status: "clean" },
		specConformanceDisclosure: "",
		inputsHash: "hash-1",
		memberCount: 1,
		requiresAcceptConfirmation: false,
		...overrides,
	};
}

const CONSTITUTION: JudgeConstitution = {
	version: 1,
	rubric: [
		{ key: "direction", label: "Direction alignment", bands: [{ minScore: 0, maxScore: 1, description: "x" }] },
		{ key: "drift", label: "Drift honesty", bands: [{ minScore: 0, maxScore: 1, description: "x" }] },
		{ key: "blastRadius", label: "Blast radius", bands: [{ minScore: 0, maxScore: 1, description: "x" }] },
		{
			key: "reversibility",
			label: "Reversibility",
			// Three realistic bands (matching docs/judge-constitution.md's actual shape) rather
			// than one band spanning 0..1 — a single band would make isInLowestBand (gate.ts)
			// treat almost any score below 1.0 as "the lowest band," which is wrong once this
			// fixture is exercised against the real gate logic (see judgeGate.test.ts's own
			// fixture for the same reason).
			bands: [
				{ minScore: 0, maxScore: 0.4, description: "not cleanly reversible" },
				{ minScore: 0.4, maxScore: 0.8, description: "mostly reversible" },
				{ minScore: 0.8, maxScore: 1, description: "cleanly reversible" },
			],
		},
		{ key: "precedent", label: "Precedent match", bands: [{ minScore: 0, maxScore: 1, description: "x" }] },
	],
	riskTaxonomy: [],
	thresholds: { autoAcceptConfidence: 0.9, autoRejectConfidence: 0.95, maxBlastRadiusAuto: 15 },
};

const VALID_VERDICT_JSON = JSON.stringify({
	gesture: "accept",
	confidence: 0.95,
	criteria: { direction: 0.9, drift: 0.9, blastRadius: 0.8, reversibility: 0.9, precedent: 0.7 },
	riskFlags: [],
	rationale: "clean extension of an accepted precedent",
	precedentIds: [],
});

function makeDeps(overrides: Partial<JudgeRunDeps> = {}): JudgeRunDeps {
	return {
		mode: "shadow",
		constitution: CONSTITUTION,
		thresholds: CONSTITUTION.thresholds,
		provider: new FakeLlmProvider(),
		getQueueState: () => ({ entries: [] }),
		getShelfState: () => ({ entries: [] }),
		getDecidedEntries: () => [],
		verdictStore: new JudgeVerdictStore(),
		slack: new NoopSlackNotifier(),
		...overrides,
	};
}

class RecordingSink implements InstrumentationSink {
	readonly entries: JudgeVerdictLog[] = [];
	logJudgeVerdict(entry: JudgeVerdictLog): void {
		this.entries.push(entry);
	}
}

describe("runJudgeForBundle", () => {
	it("never runs the judge when mode is off", async () => {
		const provider = new FakeLlmProvider();
		provider.queueResponse(VALID_VERDICT_JSON);
		const verdictStore = new JudgeVerdictStore();
		await runJudgeForBundle(makeBundle(), makeCard(), makeDeps({ mode: "off", provider, verdictStore }));
		expect(provider.calls).toHaveLength(0);
		expect(verdictStore.list()).toHaveLength(0);
	});

	it("never runs the judge on a bundle with flagged drift", async () => {
		const provider = new FakeLlmProvider();
		provider.queueResponse(VALID_VERDICT_JSON);
		const card = makeCard({ drift: { status: "flagged", signals: [] } });
		const verdictStore = new JudgeVerdictStore();
		await runJudgeForBundle(makeBundle(), card, makeDeps({ provider, verdictStore }));
		expect(provider.calls).toHaveLength(0);
		expect(verdictStore.list()).toHaveLength(0);
	});

	it("never runs the judge on a bundle with flagged spec conformance", async () => {
		const provider = new FakeLlmProvider();
		provider.queueResponse(VALID_VERDICT_JSON);
		const card = makeCard({ specConformance: { status: "flagged", signals: [] } });
		const verdictStore = new JudgeVerdictStore();
		await runJudgeForBundle(makeBundle(), card, makeDeps({ provider, verdictStore }));
		expect(provider.calls).toHaveLength(0);
		expect(verdictStore.list()).toHaveLength(0);
	});

	it("is idempotent: skips a bundle already judged at this exact inputsHash", async () => {
		const provider = new FakeLlmProvider();
		provider.queueResponse(VALID_VERDICT_JSON);
		const verdictStore = new JudgeVerdictStore();
		await verdictStore.save({ bundleId: "bundle-1", inputsHash: "hash-1", mode: "shadow", computedAt: "x", status: "abstained", abstainReason: "prior run" });
		await runJudgeForBundle(makeBundle(), makeCard(), makeDeps({ provider, verdictStore }));
		expect(provider.calls).toHaveLength(0);
	});

	it("re-judges a bundle whose inputsHash changed since the last judged verdict", async () => {
		const provider = new FakeLlmProvider();
		provider.queueResponse(VALID_VERDICT_JSON);
		const verdictStore = new JudgeVerdictStore();
		await verdictStore.save({ bundleId: "bundle-1", inputsHash: "old-hash", mode: "shadow", computedAt: "x", status: "abstained", abstainReason: "prior run" });
		await runJudgeForBundle(makeBundle(), makeCard({ inputsHash: "hash-1" }), makeDeps({ provider, verdictStore }));
		expect(provider.calls).toHaveLength(1);
	});

	it("persists and logs an abstained verdict without ever calling the gate", async () => {
		const verdictStore = new JudgeVerdictStore();
		const sink = new RecordingSink();
		// FakeLlmProvider with an empty queue returns "[]", which fails schema validation
		// every attempt and abstains after retries — no queued response needed.
		await runJudgeForBundle(makeBundle(), makeCard(), makeDeps({ verdictStore, sink }));

		const record = verdictStore.find("bundle-1", "hash-1");
		expect(record?.status).toBe("abstained");
		expect(sink.entries).toHaveLength(1);
		expect(sink.entries[0]).toMatchObject({ bundleId: "bundle-1", status: "abstained", mode: "shadow" });
	});

	it("persists and logs an ok verdict with the gate's allow decision", async () => {
		const provider = new FakeLlmProvider();
		provider.queueResponse(VALID_VERDICT_JSON);
		const verdictStore = new JudgeVerdictStore();
		const sink = new RecordingSink();
		await runJudgeForBundle(makeBundle(), makeCard(), makeDeps({ provider, verdictStore, sink }));

		const record = verdictStore.find("bundle-1", "hash-1");
		expect(record?.status).toBe("ok");
		expect(record?.verdict?.gesture).toBe("accept");
		expect(record?.gate?.allowed).toBe(true);
		expect(sink.entries[0]).toMatchObject({ bundleId: "bundle-1", status: "ok", gesture: "accept", gateAllowed: true, mode: "shadow" });
	});

	it("computes and logs the gate's escalate decision in shadow mode without acting on it", async () => {
		const provider = new FakeLlmProvider();
		provider.queueResponse(
			JSON.stringify({
				gesture: "accept",
				confidence: 0.5,
				criteria: { direction: 0.5, drift: 0.5, blastRadius: 0.5, reversibility: 0.5, precedent: 0.5 },
				riskFlags: [],
				rationale: "low confidence",
				precedentIds: [],
			}),
		);
		const verdictStore = new JudgeVerdictStore();
		const sink = new RecordingSink();
		await runJudgeForBundle(makeBundle(), makeCard(), makeDeps({ mode: "shadow", provider, verdictStore, sink }));

		const record = verdictStore.find("bundle-1", "hash-1");
		expect(record?.gate?.allowed).toBe(false);
		expect(sink.entries[0]?.gateAllowed).toBe(false);
	});

	it("never throws when the instrumentation sink itself throws", async () => {
		const provider = new FakeLlmProvider();
		provider.queueResponse(VALID_VERDICT_JSON);
		const verdictStore = new JudgeVerdictStore();
		const throwingSink: InstrumentationSink = {
			logJudgeVerdict: () => {
				throw new Error("sink is down");
			},
		};
		await expect(runJudgeForBundle(makeBundle(), makeCard(), makeDeps({ provider, verdictStore, sink: throwingSink }))).resolves.toBeUndefined();
		// The verdict is still persisted even though logging failed — instrumentation is an
		// add-on, never a hard dependency of the judge's own state.
		expect(verdictStore.find("bundle-1", "hash-1")?.status).toBe("ok");
	});

	it("never throws when the verdict store itself throws (fails closed, logs, ingestion continues)", async () => {
		const provider = new FakeLlmProvider();
		provider.queueResponse(VALID_VERDICT_JSON);
		const verdictStore = new JudgeVerdictStore();
		verdictStore.save = async () => {
			throw new Error("disk full");
		};
		await expect(runJudgeForBundle(makeBundle(), makeCard(), makeDeps({ provider, verdictStore }))).resolves.toBeUndefined();
	});

	describe("mode dispatch", () => {
		it("shadow mode sends a Slack shadow-prediction, never an outcome or escalation, and never touches actionDeps", async () => {
			const provider = new FakeLlmProvider();
			provider.queueResponse(VALID_VERDICT_JSON);
			const slack = new RecordingSlack();
			await runJudgeForBundle(makeBundle(), makeCard(), makeDeps({ mode: "shadow", provider, slack }));

			expect(slack.shadowPredictions).toHaveLength(1);
			expect(slack.shadowPredictions[0]).toMatchObject({ bundleId: "bundle-1", wouldGesture: "accept", wouldAutoAct: true });
			expect(slack.outcomes).toHaveLength(0);
			expect(slack.escalations).toHaveLength(0);
		});

		it("shadow mode's shadow-prediction reflects a gate-disallowed verdict as wouldAutoAct: false", async () => {
			const provider = new FakeLlmProvider();
			provider.queueResponse(
				JSON.stringify({
					gesture: "accept",
					confidence: 0.1,
					criteria: { direction: 0.5, drift: 0.5, blastRadius: 0.5, reversibility: 0.5, precedent: 0.5 },
					riskFlags: [],
					rationale: "low confidence",
					precedentIds: [],
				}),
			);
			const slack = new RecordingSlack();
			await runJudgeForBundle(makeBundle(), makeCard(), makeDeps({ mode: "shadow", provider, slack }));

			expect(slack.shadowPredictions[0]?.wouldAutoAct).toBe(false);
		});

		it("assist mode annotates the card in cardsMap with the judge's recommendation, without touching Slack", async () => {
			const provider = new FakeLlmProvider();
			provider.queueResponse(VALID_VERDICT_JSON);
			const slack = new RecordingSlack();
			const cardsMap = new Map([["bundle-1", makeCard()]]);
			await runJudgeForBundle(makeBundle(), makeCard(), makeDeps({ mode: "assist", provider, slack, cardsMap }));

			const annotated = cardsMap.get("bundle-1");
			expect(annotated?.judgeRecommendation).toMatchObject({ gesture: "accept", confidence: 0.95, wouldAutoAct: true });
			expect(slack.outcomes).toHaveLength(0);
			expect(slack.escalations).toHaveLength(0);
			expect(slack.shadowPredictions).toHaveLength(0);
		});

		it("assist mode never calls attemptAutoAction even when actionDeps happens to be set", async () => {
			const provider = new FakeLlmProvider();
			provider.queueResponse(VALID_VERDICT_JSON);
			const slack = new RecordingSlack();
			const actionDeps = await makeFakeActionDeps(slack);
			await runJudgeForBundle(
				makeBundle(),
				makeCard(),
				makeDeps({ mode: "assist", provider, slack, cardsMap: new Map([["bundle-1", makeCard()]]), actionDeps }),
			);

			expect(actionDeps.actionStore.list()).toHaveLength(0);
		});

		it("auto mode samples a gate-allowed verdict for human audit instead of acting, per QUIRE_JUDGE_AUDIT_SAMPLE_RATE", async () => {
			const provider = new FakeLlmProvider();
			provider.queueResponse(VALID_VERDICT_JSON);
			const slack = new RecordingSlack();
			const actionDeps = await makeFakeActionDeps(slack);
			const randomSpy = jest.spyOn(Math, "random").mockReturnValue(0.05);

			await runJudgeForBundle(makeBundle(), makeCard(), makeDeps({ mode: "auto", provider, slack, auditSampleRate: 0.1, actionDeps }));

			expect(actionDeps.actionStore.list()).toHaveLength(0);
			expect(slack.escalations).toHaveLength(1);
			expect(slack.escalations[0]?.reason).toMatch(/sampled for human audit/);
			randomSpy.mockRestore();
		});

		it("auto mode acts normally when the random draw falls outside the sample rate", async () => {
			const provider = new FakeLlmProvider();
			provider.queueResponse(VALID_VERDICT_JSON);
			const slack = new RecordingSlack();
			const actionDeps = await makeFakeActionDeps(slack);
			const randomSpy = jest.spyOn(Math, "random").mockReturnValue(0.5);

			await runJudgeForBundle(makeBundle(), makeCard(), makeDeps({ mode: "auto", provider, slack, auditSampleRate: 0.1, actionDeps }));

			expect(actionDeps.actionStore.list()).toHaveLength(1);
			expect(slack.escalations).toHaveLength(0);
			randomSpy.mockRestore();
		});

		it("auto mode never samples when auditSampleRate is unset", async () => {
			const provider = new FakeLlmProvider();
			provider.queueResponse(VALID_VERDICT_JSON);
			const slack = new RecordingSlack();
			const actionDeps = await makeFakeActionDeps(slack);
			const randomSpy = jest.spyOn(Math, "random").mockReturnValue(0);

			await runJudgeForBundle(makeBundle(), makeCard(), makeDeps({ mode: "auto", provider, slack, actionDeps }));

			expect(actionDeps.actionStore.list()).toHaveLength(1);
			randomSpy.mockRestore();
		});
	});
});
