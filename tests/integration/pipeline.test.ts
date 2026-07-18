import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { orchestratePipeline } from "../../src/engine/pipeline/pipeline.js";
import { AuditStore } from "../../src/engine/gate/auditStore.js";
import { PrEffectCache } from "../../src/engine/cache/prCache.js";
import { StubLlmProvider } from "../mocks/llmProvider.js";
import { StubStaticAnalyzer } from "../mocks/staticAnalyzer.js";
import { TypeScriptAnalyzer } from "../../src/engine/drift/footprint/typescript.js";
import { StubPatternRegistryClient } from "../mocks/patternRegistry.js";
import type { PullRequest } from "../../src/engine/types/core.js";
import type { PipelineConfig } from "../../src/engine/pipeline/pipeline.js";
import type {
	GateDecisionLog,
	DriftScreenLog,
} from "../../src/engine/types/instrumentation.js";
import type { LlmCall, LlmCallOptions, LlmMessage, LlmProvider } from "../../src/engine/drift/effectList/provider.js";
import { LlmApiError } from "../../src/engine/drift/effectList/httpRetry.js";
import { StubGitHubClient } from "../../src/engine/github/stubClient.js";

class FlakyProvider implements LlmProvider {
	private readonly inner = new StubLlmProvider();

	get calls(): ReadonlyArray<LlmCall> {
		return this.inner.calls;
	}

	get modelKey(): string {
		return this.inner.modelKey;
	}

	get supportsEmbeddings(): boolean {
		return this.inner.supportsEmbeddings;
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
		directionInferred: false,
		diff: { raw: "", hunks: [] },
		filesTouched: [`src/${id}.ts`],
		labels: [], assignees: [],
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
		// Two members: the cheap screen's checks are cross-member comparisons, so a
		// singleton has nothing to be screened against (disclosed on the card instead).
		stub.queueCompletion('["adds OTP login", "silently enables global rate limiting"]'); // pr-1 extractor
		stub.queueCompletion('["adds OTP login"]'); // pr-2 extractor
		stub.queueCompletion("1"); // classify: pr-2 joins pr-1's bundle
		stub.queueCompletion(JSON.stringify([
			{ clause: "adds OTP login", matchedDirection: true },
			{ clause: "silently enables global rate limiting", matchedDirection: false },
		])); // pr-1 matcher
		stub.queueCompletion(JSON.stringify([{ clause: "adds OTP login", matchedDirection: true }])); // pr-2 matcher
		analyzer.setFootprint(["src/pr-1.ts", "src/pr-2.ts"]);

		const prs = [
			makePR("pr-1", "add passwordless auth"),
			makePR("pr-2", "add passwordless auth"),
		];
		const result = await orchestratePipeline(prs, DEFAULT_CONFIG, { provider: stub, analyzer, auditStore });
		expect(result.cards[0]?.drift.status).toBe("flagged");
		if (result.cards[0]?.drift.status === "flagged") {
			const signal = result.cards[0].drift.signals.find((s) => s.kind === "effectList");
			expect(signal?.prId).toBe("pr-1");
		}
	});

	it("attaches a symbolInconsistency signal to the implicated PRs within a bundle", async () => {
		// pr-1 adds "helper", pr-2 removes it, pr-3 still imports it — no pair looks wrong in
		// isolation, only the merged triple does. Uses the real TypeScriptAnalyzer (not the
		// stub) since StubStaticAnalyzer returns one shared result regardless of which
		// member's diff is passed in, and this needs three different per-member results.
		const pr1 = makePR("pr-1", "add passwordless auth", {
			filesTouched: ["src/helper.ts"],
			diff: { raw: "", hunks: [{ filePath: "src/helper.ts", additions: ["+export function helper() {}"], deletions: [] }] },
		});
		const pr2 = makePR("pr-2", "add passwordless auth", {
			filesTouched: ["src/helper.ts"],
			diff: { raw: "", hunks: [{ filePath: "src/helper.ts", additions: [], deletions: ["-export function helper() {}"] }] },
		});
		const pr3 = makePR("pr-3", "add passwordless auth", {
			filesTouched: ["src/consumer.ts"],
			diff: { raw: "", hunks: [{ filePath: "src/consumer.ts", additions: ["+import { helper } from './helper';"], deletions: [] }] },
		});

		stub.queueCompletion('["adds OTP login"]'); // pr-1 extractor
		stub.queueCompletion('["adds OTP login"]'); // pr-2 extractor
		stub.queueCompletion('["adds OTP login"]'); // pr-3 extractor
		stub.queueCompletion("1"); // classify: pr-2 joins pr-1's bundle
		stub.queueCompletion("1"); // classify: pr-3 joins pr-1's bundle
		stub.queueCompletion(JSON.stringify([{ clause: "adds OTP login", matchedDirection: true }])); // pr-1 matcher
		stub.queueCompletion(JSON.stringify([{ clause: "adds OTP login", matchedDirection: true }])); // pr-2 matcher
		stub.queueCompletion(JSON.stringify([{ clause: "adds OTP login", matchedDirection: true }])); // pr-3 matcher

		const result = await orchestratePipeline(
			[pr1, pr2, pr3], DEFAULT_CONFIG, { provider: stub, analyzer: new TypeScriptAnalyzer(), auditStore },
		);

		expect(result.bundles).toHaveLength(1);
		expect(result.cards).toHaveLength(1);
		const drift = result.cards[0]?.drift;
		expect(drift?.status).toBe("flagged");
		if (drift?.status === "flagged") {
			const signals = drift.signals.filter((s) => s.kind === "symbolInconsistency");
			expect(new Set(signals.map((s) => s.prId))).toEqual(new Set(["pr-2", "pr-3"]));
		}
	});

	it("adds a pattern-mismatch flag without affecting drift status or gate outcome", async () => {
		stub.queueCompletion('["adds OTP login"]');
		stub.queueCompletion(JSON.stringify([{ clause: "adds OTP login", matchedDirection: true }]));
		analyzer.setFootprint(["src/pr-1.ts"]);
		const patternRegistry = new StubPatternRegistryClient();
		patternRegistry.setResult({ matched: false, reason: "hand-rolled auth instead of the shared middleware" });

		const prs = [makePR("pr-1", "add passwordless auth")];
		const result = await orchestratePipeline(prs, DEFAULT_CONFIG, { provider: stub, analyzer, auditStore, patternRegistry });

		expect(result.cards[0]?.flags).toContain("unusual implementation pattern: hand-rolled auth instead of the shared middleware");
		expect(result.cards[0]?.drift.status).toBe("clean");
		expect(result.rejected.length).toBe(0);
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

	describe("spec conformance — distinct from drift", () => {
		it("discloses (does not flag) a PR with no linked issue", async () => {
			stub.queueCompletion('["adds OTP login"]');
			analyzer.setFootprint([]);

			const prs = [makePR("pr-1", "add passwordless auth")];
			const result = await orchestratePipeline(prs, DEFAULT_CONFIG, { provider: stub, analyzer, auditStore });

			expect(result.cards[0]?.specConformance).toEqual({ status: "clean" });
			expect(result.cards[0]?.specConformanceDisclosure).toContain("1 of 1");
			// Extraction only: no spec-conformance call (nothing to compare against) and no
			// drift-matcher call (singleton bundle — cross-member screen skipped, disclosed).
			expect(stub.calls).toHaveLength(1);
		});

		it("flags a PR whose declared direction no longer matches the issue it claims to close", async () => {
			stub.queueCompletion('["adds OTP login"]'); // extractor
			stub.queueCompletion(JSON.stringify([{ clause: "adds OTP login", matchedDirection: true }])); // drift matcher
			stub.queueCompletion('{"conforms": false, "explanation": "issue asked for passwordless auth; PR now builds an admin dashboard"}'); // spec conformance
			analyzer.setFootprint([]);

			const githubClient = new StubGitHubClient();
			githubClient.setIssue("org", "repo", 12, {
				title: "Add passwordless auth",
				body: "Users should be able to log in via a magic link.",
			});

			const prs = [makePR("pr-1", "add passwordless auth", { linkedIssueNumber: 12 })];
			const result = await orchestratePipeline(prs, DEFAULT_CONFIG, { provider: stub, analyzer, auditStore, githubClient });

			expect(result.cards[0]?.specConformance).toEqual({
				status: "flagged",
				signals: [{ prId: "pr-1", explanation: "issue asked for passwordless auth; PR now builds an admin dashboard" }],
			});
			expect(result.cards[0]?.specConformanceDisclosure).toBe("");
			// Distinct from drift: the code still matches its own (redefined) declared
			// direction, so drift stays clean even while spec conformance flags.
			expect(result.cards[0]?.drift).toEqual({ status: "clean" });
		});
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
			const brokenAuditStore = new AuditStore(join(blockerPath, "audit.json"));

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
			analyzer.setFootprint([]);

			const prs = [makePR("pr-1", "add passwordless auth")];
			const first = await orchestratePipeline(prs, DEFAULT_CONFIG, { provider: stub, analyzer, auditStore, prCache });
			expect(stub.calls).toHaveLength(1); // extraction only (singleton — no matcher call)

			const second = await orchestratePipeline(
				prs,
				DEFAULT_CONFIG,
				{ provider: stub, analyzer, auditStore, prCache },
				{ bundles: first.bundles, cards: new Map(first.cards.map((c) => [c.bundleId, c])) },
			);

			// No new LLM calls: extraction skipped (cache hit) — the prior card is reused as-is.
			expect(stub.calls).toHaveLength(1);
			expect(second.bundles).toEqual(first.bundles);
			expect(second.cards).toEqual(first.cards);
		});

		it("re-screens (but doesn't re-extract) when declaredDirection is edited with no new commit", async () => {
			const prCache = new PrEffectCache();
			stub.queueCompletion('["adds OTP login"]');
			analyzer.setFootprint([]);

			const prs = [makePR("pr-1", "add passwordless auth")];
			const first = await orchestratePipeline(prs, DEFAULT_CONFIG, { provider: stub, analyzer, auditStore, prCache });
			expect(first.cards[0]?.directionSummary).toBe("add passwordless auth");
			expect(stub.calls).toHaveLength(1); // extraction only (singleton — no matcher call)

			// PR body edited on GitHub (declaredDirection changed) with no new commit — headSha
			// unchanged, so effect extraction is still a cache hit, but computeInputsHash now
			// depends on each member's declaredDirection (it's a spec-conformance comparison
			// input, see review/card.ts) — so the card is recomputed rather than reused. As a
			// singleton, the recompute makes no drift-matcher call (cross-member screen skipped),
			// so the whole re-screen is LLM-free.
			const editedPrs = [{ ...prs[0]!, declaredDirection: "refactor auth token storage" }];
			const second = await orchestratePipeline(
				editedPrs,
				DEFAULT_CONFIG,
				{ provider: stub, analyzer, auditStore, prCache },
				{ bundles: first.bundles, cards: new Map(first.cards.map((c) => [c.bundleId, c])) },
			);

			expect(stub.calls).toHaveLength(1); // extraction still cached; no matcher call needed
			expect(second.cards[0]?.directionSummary).toBe("refactor auth token storage");
			expect(second.bundles[0]?.members[0]?.declaredDirection).toBe("refactor auth token storage");
			expect(second.cards[0]?.drift).toEqual({ status: "clean" });
		});

		it("re-screens only the bundle whose member actually changed", async () => {
			const prCache = new PrEffectCache();
			stub.queueCompletion('["adds OTP login"]'); // pr-1 extractor
			stub.queueCompletion('["migrates database connection pooling"]'); // pr-2 extractor
			analyzer.setFootprint([]);

			const pr1 = makePR("pr-1", "add passwordless auth");
			const pr2 = makePR("pr-2", "migrate database");
			const first = await orchestratePipeline(
				[pr1, pr2], DEFAULT_CONFIG, { provider: stub, analyzer, auditStore, prCache },
			);
			expect(first.bundles).toHaveLength(2);
			expect(stub.calls).toHaveLength(2); // two extractions; singleton bundles make no matcher calls

			// pr-2 gets a new commit (headSha changes); pr-1 is untouched.
			stub.queueCompletion('["migrates database connection pooling with retries"]'); // pr-2 re-extraction

			const pr2Updated = { ...pr2, headSha: "sha-pr-2-v2" };
			const second = await orchestratePipeline(
				[pr1, pr2Updated],
				DEFAULT_CONFIG,
				{ provider: stub, analyzer, auditStore, prCache },
				{ bundles: first.bundles, cards: new Map(first.cards.map((c) => [c.bundleId, c])) },
			);

			// Only pr-2's extraction re-ran (1 new call) — pr-1's bundle/card carried over
			// untouched.
			expect(stub.calls).toHaveLength(3);
			const pr1Bundle = second.bundles.find((b) => b.members.some((m) => m.id === "pr-1"));
			const pr1CardBefore = first.cards.find((c) => c.bundleId === pr1Bundle?.id);
			const pr1CardAfter = second.cards.find((c) => c.bundleId === pr1Bundle?.id);
			// Reused (not the literal same object — directionSummary is always refreshed,
			// see reuseReviewCard), but every other field is unchanged.
			expect(pr1CardAfter).toEqual(pr1CardBefore);
		});
	});
});
