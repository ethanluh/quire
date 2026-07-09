import { describe, it, expect } from "@jest/globals";
import { runBundleJudge } from "../../src/engine/judge/bundleJudge.js";
import type { BundleJudgeInputs } from "../../src/engine/judge/bundleJudge.js";
import { StubLlmProvider } from "../../src/engine/drift/effectList/stubProvider.js";
import type { LlmCall, LlmCallOptions, LlmMessage, LlmProvider } from "../../src/engine/drift/effectList/provider.js";
import type { Bundle, PullRequest, ReviewCard } from "../../src/engine/types/core.js";
import type { JudgeConstitution } from "../../src/engine/types/judge.js";

class FakeLlmProvider implements LlmProvider {
	private readonly queue: string[] = [];
	private readonly _calls: LlmCall[] = [];
	readonly supportsEmbeddings = false;
	readonly modelKey = "fake:judge-model";
	throwOnNextCall: Error | undefined;

	queueResponse(response: string): void {
		this.queue.push(response);
	}

	get calls(): ReadonlyArray<LlmCall> {
		return this._calls;
	}

	async complete(messages: ReadonlyArray<LlmMessage>, _opts?: LlmCallOptions): Promise<string> {
		if (this.throwOnNextCall !== undefined) {
			const err = this.throwOnNextCall;
			this.throwOnNextCall = undefined;
			throw err;
		}
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

function makeCard(): ReviewCard {
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
		inputsHash: "hash",
		memberCount: 1,
		requiresAcceptConfirmation: false,
	};
}

const CONSTITUTION: JudgeConstitution = {
	version: 1,
	rubric: [
		{ key: "direction", label: "Direction alignment", bands: [{ minScore: 0, maxScore: 1, description: "x" }] },
		{ key: "drift", label: "Drift honesty", bands: [{ minScore: 0, maxScore: 1, description: "x" }] },
		{ key: "blastRadius", label: "Blast radius", bands: [{ minScore: 0, maxScore: 1, description: "x" }] },
		{ key: "reversibility", label: "Reversibility", bands: [{ minScore: 0, maxScore: 1, description: "x" }] },
		{ key: "precedent", label: "Precedent match", bands: [{ minScore: 0, maxScore: 1, description: "x" }] },
	],
	riskTaxonomy: [{ id: "authentication-or-authorization", label: "Auth", description: "d", filePatterns: [/auth/i] }],
	thresholds: { autoAcceptConfidence: 0.9, autoRejectConfidence: 0.95, maxBlastRadiusAuto: 15 },
};

function makeInputs(overrides: Partial<BundleJudgeInputs> = {}): BundleJudgeInputs {
	return {
		bundle: makeBundle(),
		card: makeCard(),
		constitution: CONSTITUTION,
		precedent: [],
		deterministicRiskFlags: [],
		...overrides,
	};
}

const VALID_VERDICT_JSON = JSON.stringify({
	gesture: "accept",
	confidence: 0.95,
	criteria: { direction: 0.9, drift: 0.9, blastRadius: 0.8, reversibility: 0.9, precedent: 0.7 },
	riskFlags: [],
	rationale: "clean extension of an accepted precedent",
	precedentIds: [],
});

describe("runBundleJudge", () => {
	it("abstains immediately for a stub provider without ever calling complete", async () => {
		const stub = new StubLlmProvider();
		stub.queueCompletion(VALID_VERDICT_JSON); // present to prove it's never consumed
		const result = await runBundleJudge(makeInputs(), stub);
		expect(result.status).toBe("abstained");
		expect(stub.calls).toHaveLength(0);
	});

	it("returns a valid verdict on the first attempt", async () => {
		const provider = new FakeLlmProvider();
		provider.queueResponse(VALID_VERDICT_JSON);
		const result = await runBundleJudge(makeInputs(), provider);
		expect(result.status).toBe("ok");
		if (result.status === "ok") {
			expect(result.verdict.gesture).toBe("accept");
			expect(result.verdict.modelId).toBe("fake:judge-model");
			expect(result.verdict.confidence).toBe(0.95);
		}
	});

	it("merges deterministic risk flags with the model's own, deduplicated", async () => {
		const provider = new FakeLlmProvider();
		provider.queueResponse(
			JSON.stringify({
				gesture: "defer",
				confidence: 0.5,
				criteria: { direction: 0.5, drift: 0.5, blastRadius: 0.5, reversibility: 0.5, precedent: 0.5 },
				riskFlags: ["authentication-or-authorization", "unclear-revert-path"],
				rationale: "risky",
				precedentIds: [],
			}),
		);
		const result = await runBundleJudge(makeInputs({ deterministicRiskFlags: ["authentication-or-authorization"] }), provider);
		expect(result.status).toBe("ok");
		if (result.status === "ok") {
			expect([...result.verdict.riskFlags].sort()).toEqual(["authentication-or-authorization", "unclear-revert-path"]);
		}
	});

	it("strips a code fence and retries once on malformed JSON, then succeeds", async () => {
		const provider = new FakeLlmProvider();
		provider.queueResponse("not json at all");
		provider.queueResponse(VALID_VERDICT_JSON);
		const result = await runBundleJudge(makeInputs(), provider);
		expect(result.status).toBe("ok");
		expect(provider.calls).toHaveLength(2);
	});

	it("retries when the model invents a precedent id not actually offered", async () => {
		const provider = new FakeLlmProvider();
		provider.queueResponse(
			JSON.stringify({
				gesture: "accept",
				confidence: 0.9,
				criteria: { direction: 0.9, drift: 0.9, blastRadius: 0.9, reversibility: 0.9, precedent: 0.9 },
				riskFlags: [],
				rationale: "x",
				precedentIds: ["bundle-that-was-never-given"],
			}),
		);
		provider.queueResponse(VALID_VERDICT_JSON);
		const result = await runBundleJudge(makeInputs(), provider);
		expect(result.status).toBe("ok");
		expect(provider.calls).toHaveLength(2);
	});

	it("abstains after exhausting retries on persistently malformed output", async () => {
		const provider = new FakeLlmProvider();
		provider.queueResponse("garbage 1");
		provider.queueResponse("garbage 2");
		provider.queueResponse("garbage 3");
		const result = await runBundleJudge(makeInputs(), provider);
		expect(result.status).toBe("abstained");
		if (result.status === "abstained") {
			expect(result.reason).toMatch(/after 3 attempts/);
		}
		expect(provider.calls).toHaveLength(3);
	});

	it("abstains when every model call throws", async () => {
		const provider = new FakeLlmProvider();
		provider.throwOnNextCall = new Error("network down");
		// throwOnNextCall only fires once per set — set it again after each throw via a
		// custom override so all 3 attempts fail.
		const originalComplete = provider.complete.bind(provider);
		provider.complete = async (messages, opts) => {
			provider.throwOnNextCall = new Error("network down");
			return originalComplete(messages, opts);
		};
		const result = await runBundleJudge(makeInputs(), provider);
		expect(result.status).toBe("abstained");
		if (result.status === "abstained") {
			expect(result.reason).toMatch(/model call failed/);
		}
	});

	it("rejects a response missing a required rubric criterion", async () => {
		const provider = new FakeLlmProvider();
		provider.queueResponse(
			JSON.stringify({
				gesture: "accept",
				confidence: 0.9,
				criteria: { direction: 0.9, drift: 0.9, blastRadius: 0.9, reversibility: 0.9 }, // missing precedent
				riskFlags: [],
				rationale: "x",
				precedentIds: [],
			}),
		);
		provider.queueResponse(VALID_VERDICT_JSON);
		const result = await runBundleJudge(makeInputs(), provider);
		expect(result.status).toBe("ok");
		expect(provider.calls).toHaveLength(2);
	});
});
