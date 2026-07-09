import { describe, it, expect } from "@jest/globals";
import { ingestIntoQueue } from "../../src/interface/server/ingestIntoQueue.js";
import type { PipelineDeps } from "../../src/interface/server/ingestIntoQueue.js";
import type { JudgeRunDeps } from "../../src/engine/judge/orchestrate.js";
import { createServerState } from "../../src/interface/server/state.js";
import { JudgeVerdictStore } from "../../src/engine/judge/judgeVerdictStore.js";
import { StubStaticAnalyzer } from "../mocks/staticAnalyzer.js";
import { AuditStore } from "../../src/engine/gate/auditStore.js";
import { PrEffectCache } from "../../src/engine/cache/prCache.js";
import type { PipelineConfig } from "../../src/engine/pipeline/pipeline.js";
import type { PullRequest } from "../../src/engine/types/core.js";
import type { JudgeConstitution } from "../../src/engine/types/judge.js";
import type { LlmCall, LlmMessage, LlmProvider } from "../../src/engine/drift/effectList/provider.js";

function makePR(id: string): PullRequest {
	return {
		id,
		repoOwner: "org",
		repoName: "repo",
		number: 1,
		headSha: `sha-${id}`,
		declaredDirection: "add passwordless auth",
		directionInferred: false,
		diff: { raw: "diff --git a/x b/x", hunks: [] },
		filesTouched: [`src/${id}.ts`],
		symbolsTouched: [],
		testNamesChanged: [],
		ciStatus: "success",
	};
}

// Branches on each call's own system prompt (matching extractor.ts's / matcher.ts's exact
// wording) rather than returning one fixed response for every call — the pipeline sends
// several structurally different prompts through the same provider.complete(), and this test
// needs the drift screen to actually come back clean so the bundle is judge-eligible.
function makeCleanScreenProvider(): LlmProvider {
	const calls: LlmCall[] = [];
	return {
		modelKey: "stub:clean-screen",
		supportsEmbeddings: false,
		get calls(): ReadonlyArray<LlmCall> {
			return calls;
		},
		async complete(messages: ReadonlyArray<LlmMessage>) {
			const system = messages.find((m) => m.role === "system")?.content ?? "";
			let response: string;
			if (system.includes("List every distinct product-level effect")) {
				response = JSON.stringify(["adds passwordless auth"]);
			} else if (system.includes("decide whether it matches the stated direction")) {
				response = JSON.stringify([{ clause: "adds passwordless auth", matchedDirection: true }]);
			} else {
				response = "[]";
			}
			calls.push({ messages, response });
			return response;
		},
		async embed() {
			return [];
		},
	};
}

const JUDGE_MODEL_PROVIDER_ABSTAINS = "fake:no-queued-response";

// A provider distinct from the drift/screen provider above, standing in for the judge's own
// (bias-mitigated) model — its queue is always empty, so runBundleJudge abstains immediately
// after exhausting retries. That's sufficient to prove the wiring: this test's assertions are
// about whether the judge ran at all, not about what it decided.
function makeAbstainingJudgeProvider(): LlmProvider {
	const calls: LlmCall[] = [];
	return {
		modelKey: JUDGE_MODEL_PROVIDER_ABSTAINS,
		supportsEmbeddings: false,
		get calls(): ReadonlyArray<LlmCall> {
			return calls;
		},
		async complete(messages: ReadonlyArray<LlmMessage>) {
			calls.push({ messages, response: "not valid json" });
			return "not valid json";
		},
		async embed() {
			return [];
		},
	};
}

const PIPELINE_CONFIG: PipelineConfig = {
	gate: { criteria: [] },
	bundle: { similarityThreshold: 0.75 },
};

const CONSTITUTION: JudgeConstitution = {
	version: 1,
	rubric: [
		{ key: "direction", label: "Direction alignment", bands: [{ minScore: 0, maxScore: 1, description: "x" }] },
		{ key: "drift", label: "Drift honesty", bands: [{ minScore: 0, maxScore: 1, description: "x" }] },
		{ key: "blastRadius", label: "Blast radius", bands: [{ minScore: 0, maxScore: 1, description: "x" }] },
		{ key: "reversibility", label: "Reversibility", bands: [{ minScore: 0, maxScore: 1, description: "x" }] },
		{ key: "precedent", label: "Precedent match", bands: [{ minScore: 0, maxScore: 1, description: "x" }] },
	],
	riskTaxonomy: [],
	thresholds: { autoAcceptConfidence: 0.9, autoRejectConfidence: 0.95, maxBlastRadiusAuto: 15 },
};

function makeJudgeDeps(overrides: Partial<JudgeRunDeps> = {}): JudgeRunDeps {
	return {
		mode: "shadow",
		constitution: CONSTITUTION,
		thresholds: CONSTITUTION.thresholds,
		provider: makeAbstainingJudgeProvider(),
		getQueueState: () => ({ entries: [] }),
		getShelfState: () => ({ entries: [] }),
		getDecidedEntries: () => [],
		verdictStore: new JudgeVerdictStore(),
		...overrides,
	};
}

describe("ingestIntoQueue — judge wiring", () => {
	it("never touches the judge when judgeDeps is omitted (existing behavior, byte-for-byte)", async () => {
		const deps: PipelineDeps = {
			config: PIPELINE_CONFIG,
			provider: makeCleanScreenProvider(),
			analyzer: new StubStaticAnalyzer(),
			auditStore: new AuditStore(),
			prCache: new PrEffectCache(),
		};

		const result = await ingestIntoQueue([makePR("pr-a")], createServerState(), deps);
		expect(result.bundlesCreated).toBe(1);
		// Nothing to assert about the judge beyond "it never ran" — there's no judgeDeps for
		// it to have written into, and the call above completing without it proves the block
		// is skipped rather than run against an absent dependency.
	});

	it("runs the judge on a newly-computed, drift-clean, spec-conformance-clean bundle", async () => {
		const verdictStore = new JudgeVerdictStore();
		const judgeProvider = makeAbstainingJudgeProvider();
		const deps: PipelineDeps = {
			config: PIPELINE_CONFIG,
			provider: makeCleanScreenProvider(),
			analyzer: new StubStaticAnalyzer(),
			auditStore: new AuditStore(),
			prCache: new PrEffectCache(),
			judgeDeps: makeJudgeDeps({ verdictStore, provider: judgeProvider }),
		};

		const result = await ingestIntoQueue([makePR("pr-a")], createServerState(), deps);
		expect(result.bundlesCreated).toBe(1);
		const bundleId = result.bundleIds[0];
		expect(bundleId).toBeDefined();

		// The judge ran (its own provider was actually called) and recorded a verdict for
		// this exact bundle — proving ingestIntoQueue reached the hook point described in
		// docs/judge-integration-map.md §1, not just that the pipeline itself still works.
		expect(judgeProvider.calls.length).toBeGreaterThan(0);
		expect(verdictStore.list()).toHaveLength(1);
		expect(verdictStore.list()[0]?.bundleId).toBe(bundleId);
	});

	it("does not run the judge twice for the same unchanged bundle across two ingestion calls", async () => {
		const verdictStore = new JudgeVerdictStore();
		const judgeProvider = makeAbstainingJudgeProvider();
		const state = createServerState();
		const runOnce = () =>
			ingestIntoQueue([makePR("pr-a")], state, {
				config: PIPELINE_CONFIG,
				provider: makeCleanScreenProvider(),
				analyzer: new StubStaticAnalyzer(),
				auditStore: new AuditStore(),
				prCache: new PrEffectCache(),
				judgeDeps: makeJudgeDeps({ verdictStore, provider: judgeProvider }),
			});

		await runOnce();
		const callsAfterFirst = judgeProvider.calls.length;
		await runOnce();

		expect(judgeProvider.calls.length).toBe(callsAfterFirst);
		expect(verdictStore.list()).toHaveLength(1);
	});
});
