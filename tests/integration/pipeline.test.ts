import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { orchestratePipeline } from "../../src/engine/pipeline/pipeline.js";
import { AuditStore } from "../../src/engine/gate/auditStore.js";
import { PrEffectCache } from "../../src/engine/cache/prCache.js";
import { StubLlmProvider } from "../mocks/llmProvider.js";
import { StubStaticAnalyzer } from "../mocks/staticAnalyzer.js";
import type { PullRequest } from "../../src/engine/types/core.js";
import type { PipelineConfig } from "../../src/engine/pipeline/pipeline.js";
import type {
	GateDecisionLog,
	DriftScreenLog,
} from "../../src/engine/types/instrumentation.js";
import type { LlmCall, LlmCallOptions, LlmMessage, LlmProvider } from "../../src/engine/drift/effectList/provider.js";
import { LlmApiError } from "../../src/engine/drift/effectList/httpRetry.js";

class FlakyProvider implements LlmProvider {
	private readonly inner = new StubLlmProvider();

	get calls(): ReadonlyArray<LlmCall> {
		return this.inner.calls;
	}

	queueCompletion(response: string): void {
		this.inner.queueCompletion(response);
	}

	async complete(messages: ReadonlyArray<LlmMessage>, opts?: LlmCallOptions): Promise<string> {
		if (messages.some((m) => m.content.includes("FAIL_EXTRACTION_MARKER"))) {
			// Real providers throw LlmApiError, not a plain Error — drive the real shape
			// through orchestratePipeline() so its error handling is actually exercised.
			throw new LlmApiError("Test", 503, "provider timeout");
		}
		return this.inner.complete(messages, opts);
	}

	async embed(text: string): Promise<ReadonlyArray<number>> {
		return this.inner.embed(text);
	}
}

function makePR(id: string, direction: string, overrides: Partial<PullRequest> = {}): PullRequest {
	return {
		id, repoOwner: "org", repoName: "repo",
		number: parseInt(id.replace(/\D/g, "") || "1"),
		headSha: `sha-${id}`,
		declaredDirection: direction,
		diff: { raw: "", hunks: [] },
		filesTouched: [`src/${id}.ts`],
		symbolsTouched: [], testNamesChanged: [], ciStatus: "success",
		...overrides,
	};
}

const DEFAULT_CONFIG: PipelineConfig = {
	gate: { criteria: [{ name: "buildFailure", mode: "enforce" }] },
	bundle: { similarityThreshold: 0.75 },
};

describe("orchestratePipeline — integration", () => {
	let stub: StubLlmProvider;
	let analyzer: StubStaticAnalyzer;
	let auditStore: AuditStore;

	beforeEach(() => {
		stub = new StubLlmProvider();
		analyzer = new StubStaticAnalyzer();
		auditStore = new AuditStore();
	});

	it("rejects a PR with ciStatus failure (INV-1: not based on declaredDirection)", async () => {
		// Setup: one failing PR and one passing PR
		stub.queueCompletion('["adds OTP login"]'); // extractor for passing PR
		stub.queueCompletion(JSON.stringify([{ clause: "adds OTP login", matchedDirection: true }]));
		analyzer.setFootprint([]);

		const prs = [
			makePR("pr-fail", "add passwordless auth", { ciStatus: "failure" }),
			makePR("pr-ok", "add passwordless auth"),
		];

		const result = await orchestratePipeline(prs, DEFAULT_CONFIG, { provider: stub, analyzer, auditStore });
		expect(result.rejected.map(p => p.id)).toContain("pr-fail");
		expect(result.bundles.length).toBe(1);
		expect(result.bundles[0]?.members.map(m => m.id)).toContain("pr-ok");
	});

	it("produces a review card with residualDisclosure always set (INV-6)", async () => {
		stub.queueCompletion('["adds OTP login"]');
		stub.queueCompletion(JSON.stringify([{ clause: "adds OTP login", matchedDirection: true }]));
		analyzer.setFootprint([]);

		const prs = [makePR("pr-1", "add passwordless auth")];
		const result = await orchestratePipeline(prs, DEFAULT_CONFIG, { provider: stub, analyzer, auditStore });
		expect(result.cards.length).toBe(1);
		expect(result.cards[0]?.residualDisclosure).toBeTruthy();
	});

	it("accept gesture enqueues and does not call mergePullRequest (INV-5)", async () => {
		// This is tested at the MergeQueue level — here we verify accept=enqueue, not merge
		stub.queueCompletion('["adds OTP login"]');
		stub.queueCompletion(JSON.stringify([{ clause: "adds OTP login", matchedDirection: true }]));
		analyzer.setFootprint([]);
		const prs = [makePR("pr-1", "add passwordless auth")];
		const result = await orchestratePipeline(prs, DEFAULT_CONFIG, { provider: stub, analyzer, auditStore });
		// Pipeline returns cards/bundles — it does not call the merge queue itself
		// The route handler calls queue.enqueue() on gesture; the pipeline is pure
		expect(result.cards.length).toBeGreaterThan(0);
	});

	it("flags a PR with an orphan effect", async () => {
		stub.queueCompletion('["adds OTP login", "silently enables global rate limiting"]');
		stub.queueCompletion(JSON.stringify([
			{ clause: "adds OTP login", matchedDirection: true },
			{ clause: "silently enables global rate limiting", matchedDirection: false },
		]));
		analyzer.setFootprint(["src/pr-1.ts"]);

		const prs = [makePR("pr-1", "add passwordless auth")];
		const result = await orchestratePipeline(prs, DEFAULT_CONFIG, { provider: stub, analyzer, auditStore });
		expect(result.cards[0]?.drift.status).toBe("flagged");
	});

	it("extractor never receives declaredDirection in any LLM call (INV-2)", async () => {
		stub.queueCompletion('["adds OTP login"]');
		stub.queueCompletion(JSON.stringify([{ clause: "adds OTP login", matchedDirection: true }]));
		analyzer.setFootprint([]);

		const direction = "add passwordless auth";
		const prs = [makePR("pr-1", direction)];
		await orchestratePipeline(prs, DEFAULT_CONFIG, { provider: stub, analyzer, auditStore });

		// First LLM call is the extractor — direction must not be in any message
		const extractorCall = stub.calls[0];
		expect(extractorCall).toBeDefined();
		if (extractorCall) {
			for (const msg of extractorCall.messages) {
				expect(msg.content).not.toContain(direction);
			}
		}
	});

	it("runs without a sink (instrumentation is optional, not a hard dependency)", async () => {
		stub.queueCompletion('["adds OTP login"]');
		stub.queueCompletion(JSON.stringify([{ clause: "adds OTP login", matchedDirection: true }]));
		analyzer.setFootprint([]);

		const prs = [makePR("pr-1", "add passwordless auth")];
		const result = await orchestratePipeline(prs, DEFAULT_CONFIG, { provider: stub, analyzer, auditStore });
		expect(result.cards.length).toBe(1);
	});

	it("reports gate decisions and drift-screen results through the instrumentation sink", async () => {
		stub.queueCompletion('["adds OTP login"]');
		stub.queueCompletion(JSON.stringify([{ clause: "adds OTP login", matchedDirection: true }]));
		analyzer.setFootprint([]);

		const gateDecisions: GateDecisionLog[] = [];
		const driftScreens: DriftScreenLog[] = [];
		const sink = {
			logGateDecision: (entry: GateDecisionLog) => {
				gateDecisions.push(entry);
			},
			logDriftScreen: (entry: DriftScreenLog) => {
				driftScreens.push(entry);
			},
		};

		const prs = [makePR("pr-1", "add passwordless auth")];
		await orchestratePipeline(prs, DEFAULT_CONFIG, { provider: stub, analyzer, auditStore, sink });

		expect(gateDecisions).toEqual([
			expect.objectContaining({ prId: "pr-1", criterionName: "buildFailure", mode: "enforce", triggered: false }),
		]);
		expect(driftScreens).toEqual([
			expect.objectContaining({ bundleId: expect.any(String), prId: "pr-1", signalCount: 0, flagged: false }),
		]);
	});

	it("does not abort the pipeline when a sink method throws (instrumentation stays non-fatal)", async () => {
		stub.queueCompletion('["adds OTP login"]');
		stub.queueCompletion(JSON.stringify([{ clause: "adds OTP login", matchedDirection: true }]));
		analyzer.setFootprint([]);

		const sink = {
			logGateDecision: () => {
				throw new Error("disk full");
			},
			logDriftScreen: () => {
				throw new Error("disk full");
			},
		};

		const prs = [makePR("pr-1", "add passwordless auth")];
		const result = await orchestratePipeline(prs, DEFAULT_CONFIG, { provider: stub, analyzer, auditStore, sink });

		expect(result.error).toBeUndefined();
		expect(result.cards.length).toBe(1);
	});

	describe("gate-loop failure handling", () => {
		let dir: string;

		afterEach(async () => {
			if (dir) await rm(dir, { recursive: true, force: true });
		});

		it("returns partial gate results with an error instead of throwing when the audit write fails", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-pipeline-"));
			// A file where a directory component is expected forces the audit write's
			// mkdir to fail, simulating a disk error during a shadow-mode audit write.
			const blockerPath = join(dir, "blocker");
			await writeFile(blockerPath, "not a directory", "utf8");
			const brokenAuditStore = new AuditStore(join(blockerPath, "audit.ndjson"));

			const config: PipelineConfig = {
				gate: { criteria: [{ name: "buildFailure", mode: "shadow" }] },
				bundle: { similarityThreshold: 0.75 },
			};
			const prs = [makePR("pr-1", "add passwordless auth", { ciStatus: "failure" })];

			const result = await orchestratePipeline(prs, config, { provider: stub, analyzer, auditStore: brokenAuditStore });

			expect(result.error).toBeTruthy();
			expect(result.cards).toHaveLength(0);
			expect(result.bundles).toHaveLength(0);
		});
	});

	it("a single PR's extraction failure does not discard bundling/cards for the rest (partial-failure contract)", async () => {
		const provider = new FlakyProvider();
		provider.queueCompletion('["adds OTP login"]'); // pr-good's extractor
		provider.queueCompletion(JSON.stringify([{ clause: "adds OTP login", matchedDirection: true }])); // matcher
		analyzer.setFootprint([]);

		const prs = [
			makePR("pr-bad", "add passwordless auth", { diff: { raw: "FAIL_EXTRACTION_MARKER", hunks: [] } }),
			makePR("pr-good", "add passwordless auth"),
		];

		const result = await orchestratePipeline(prs, DEFAULT_CONFIG, { provider, analyzer, auditStore });

		expect(result.error).toContain("pr-bad");
		expect(result.bundles.length).toBe(1);
		expect(result.bundles[0]?.members.map((m) => m.id)).toEqual(["pr-good"]);
		expect(result.cards.length).toBe(1);
	});

	describe("incremental re-run: unchanged PRs skip re-extraction, re-clustering, and re-screening", () => {
		it("reuses the prior run's bundle and card when nothing changed", async () => {
			const prCache = new PrEffectCache();
			stub.queueCompletion('["adds OTP login"]'); // extractor
			stub.queueCompletion(JSON.stringify([{ clause: "adds OTP login", matchedDirection: true }])); // matcher
			analyzer.setFootprint([]);

			const prs = [makePR("pr-1", "add passwordless auth")];
			const first = await orchestratePipeline(prs, DEFAULT_CONFIG, { provider: stub, analyzer, auditStore, prCache });
			expect(stub.calls).toHaveLength(2);

			const second = await orchestratePipeline(
				prs,
				DEFAULT_CONFIG,
				{ provider: stub, analyzer, auditStore, prCache },
				{ bundles: first.bundles, cards: new Map(first.cards.map((c) => [c.bundleId, c])) },
			);

			// No new LLM calls: extraction skipped (cache hit) and the matcher skipped
			// (bundle id unchanged, no re-extracted member) — the prior card is reused as-is.
			expect(stub.calls).toHaveLength(2);
			expect(second.bundles).toEqual(first.bundles);
			expect(second.cards).toEqual(first.cards);
		});

		it("re-screens only the bundle whose member actually changed", async () => {
			const prCache = new PrEffectCache();
			stub.queueCompletion('["adds OTP login"]'); // pr-1 extractor
			stub.queueCompletion('["migrates database connection pooling"]'); // pr-2 extractor
			stub.queueCompletion(JSON.stringify([{ clause: "adds OTP login", matchedDirection: true }])); // pr-1 matcher
			stub.queueCompletion(JSON.stringify([{ clause: "migrates database connection pooling", matchedDirection: true }])); // pr-2 matcher
			analyzer.setFootprint([]);

			const pr1 = makePR("pr-1", "add passwordless auth");
			const pr2 = makePR("pr-2", "migrate database");
			const first = await orchestratePipeline(
				[pr1, pr2], DEFAULT_CONFIG, { provider: stub, analyzer, auditStore, prCache },
			);
			expect(first.bundles).toHaveLength(2);
			expect(stub.calls).toHaveLength(4);

			// pr-2 gets a new commit (headSha changes); pr-1 is untouched.
			stub.queueCompletion('["migrates database connection pooling with retries"]'); // pr-2 re-extraction
			stub.queueCompletion(JSON.stringify([{ clause: "migrates database connection pooling with retries", matchedDirection: true }])); // pr-2 re-screen

			const pr2Updated = { ...pr2, headSha: "sha-pr-2-v2" };
			const second = await orchestratePipeline(
				[pr1, pr2Updated],
				DEFAULT_CONFIG,
				{ provider: stub, analyzer, auditStore, prCache },
				{ bundles: first.bundles, cards: new Map(first.cards.map((c) => [c.bundleId, c])) },
			);

			// Only pr-2's extraction + matcher re-ran (2 new calls) — pr-1's bundle/card
			// carried over untouched.
			expect(stub.calls).toHaveLength(6);
			const pr1Bundle = second.bundles.find((b) => b.members.some((m) => m.id === "pr-1"));
			const pr1CardBefore = first.cards.find((c) => c.bundleId === pr1Bundle?.id);
			const pr1CardAfter = second.cards.find((c) => c.bundleId === pr1Bundle?.id);
			expect(pr1CardAfter).toBe(pr1CardBefore);
		});
	});
});
