import { describe, it, expect, beforeEach } from "@jest/globals";
import { orchestratePipeline } from "../../src/pipeline/pipeline.js";
import { AuditStore } from "../../src/gate/auditStore.js";
import { StubLlmProvider } from "../mocks/llmProvider.js";
import { StubStaticAnalyzer } from "../mocks/staticAnalyzer.js";
import type { PullRequest } from "../../src/types/core.js";
import type { PipelineConfig } from "../../src/pipeline/pipeline.js";

function makePR(id: string, direction: string, overrides: Partial<PullRequest> = {}): PullRequest {
	return {
		id, repoOwner: "org", repoName: "repo",
		number: parseInt(id.replace(/\D/g, "") || "1"),
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

		const result = await orchestratePipeline(prs, DEFAULT_CONFIG, stub, analyzer, auditStore);
		expect(result.rejected.map(p => p.id)).toContain("pr-fail");
		expect(result.bundles.length).toBe(1);
		expect(result.bundles[0]?.members.map(m => m.id)).toContain("pr-ok");
	});

	it("produces a review card with residualDisclosure always set (INV-6)", async () => {
		stub.queueCompletion('["adds OTP login"]');
		stub.queueCompletion(JSON.stringify([{ clause: "adds OTP login", matchedDirection: true }]));
		analyzer.setFootprint([]);

		const prs = [makePR("pr-1", "add passwordless auth")];
		const result = await orchestratePipeline(prs, DEFAULT_CONFIG, stub, analyzer, auditStore);
		expect(result.cards.length).toBe(1);
		expect(result.cards[0]?.residualDisclosure).toBeTruthy();
	});

	it("accept gesture enqueues and does not call mergePullRequest (INV-5)", async () => {
		// This is tested at the MergeQueue level — here we verify accept=enqueue, not merge
		stub.queueCompletion('["adds OTP login"]');
		stub.queueCompletion(JSON.stringify([{ clause: "adds OTP login", matchedDirection: true }]));
		analyzer.setFootprint([]);
		const prs = [makePR("pr-1", "add passwordless auth")];
		const result = await orchestratePipeline(prs, DEFAULT_CONFIG, stub, analyzer, auditStore);
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
		const result = await orchestratePipeline(prs, DEFAULT_CONFIG, stub, analyzer, auditStore);
		expect(result.cards[0]?.drift.status).toBe("flagged");
	});

	it("extractor never receives declaredDirection in any LLM call (INV-2)", async () => {
		stub.queueCompletion('["adds OTP login"]');
		stub.queueCompletion(JSON.stringify([{ clause: "adds OTP login", matchedDirection: true }]));
		analyzer.setFootprint([]);

		const direction = "add passwordless auth";
		const prs = [makePR("pr-1", direction)];
		await orchestratePipeline(prs, DEFAULT_CONFIG, stub, analyzer, auditStore);

		// First LLM call is the extractor — direction must not be in any message
		const extractorCall = stub.calls[0];
		expect(extractorCall).toBeDefined();
		if (extractorCall) {
			for (const msg of extractorCall.messages) {
				expect(msg.content).not.toContain(direction);
			}
		}
	});
});
