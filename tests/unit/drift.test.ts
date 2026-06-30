import { describe, it, expect, beforeEach } from "@jest/globals";
import { extractEffects } from "../../src/engine/drift/effectList/extractor.js";
import { matchEffectsToDirection } from "../../src/engine/drift/effectList/matcher.js";
import { runCheapScreen } from "../../src/engine/drift/screen.js";
import { StubLlmProvider } from "../mocks/llmProvider.js";
import { StubStaticAnalyzer } from "../mocks/staticAnalyzer.js";
import type { Bundle, Diff, PullRequest } from "../../src/engine/types/core.js";

const EMPTY_DIFF: Diff = { raw: "", hunks: [] };

function makeBundle(members: PullRequest[] = []): Bundle {
	return { id: "bundle-1", direction: "add passwordless auth", members };
}

function makePR(overrides: Partial<PullRequest> = {}): PullRequest {
	return {
		id: "pr-1", repoOwner: "org", repoName: "repo", number: 1,
		declaredDirection: "add passwordless auth",
		diff: EMPTY_DIFF, filesTouched: ["src/auth.ts"],
		symbolsTouched: [], testNamesChanged: [], ciStatus: "success",
		...overrides,
	};
}

describe("extractEffects — INV-2: direction must never appear in LLM messages", () => {
	it("does not pass declaredDirection to the provider", async () => {
		const stub = new StubLlmProvider();
		stub.queueCompletion('["adds OTP-based login flow"]');
		const pr = makePR();
		await extractEffects(pr.diff, pr.testNamesChanged, stub);

		const direction = pr.declaredDirection;
		for (const call of stub.calls) {
			for (const msg of call.messages) {
				expect(msg.content).not.toContain(direction);
			}
		}
	});

	it("parses JSON array response", async () => {
		const stub = new StubLlmProvider();
		stub.queueCompletion('["effect one", "effect two"]');
		const effects = await extractEffects(EMPTY_DIFF, [], stub);
		expect(effects).toEqual(["effect one", "effect two"]);
	});

	it("falls back to line splitting on non-JSON response", async () => {
		const stub = new StubLlmProvider();
		stub.queueCompletion("- effect one\n- effect two");
		const effects = await extractEffects(EMPTY_DIFF, [], stub);
		expect(effects).toContain("effect one");
		expect(effects).toContain("effect two");
	});
});

describe("matchEffectsToDirection", () => {
	it("sets matchedDirection from LLM response", async () => {
		const stub = new StubLlmProvider();
		stub.queueCompletion(JSON.stringify([
			{ clause: "adds OTP login", matchedDirection: true },
			{ clause: "enables rate limiting on all endpoints", matchedDirection: false },
		]));
		const effects = await matchEffectsToDirection(
			["adds OTP login", "enables rate limiting on all endpoints"],
			"add passwordless auth",
			stub,
		);
		expect(effects[0]?.matchedDirection).toBe(true);
		expect(effects[1]?.matchedDirection).toBe(false);
	});
});

describe("runCheapScreen — INV-3: clean only when zero signals", () => {
	let stub: StubLlmProvider;
	let analyzer: StubStaticAnalyzer;

	beforeEach(() => {
		stub = new StubLlmProvider();
		analyzer = new StubStaticAnalyzer();
	});

	it("returns clean when no orphans and no surprising symbols", async () => {
		stub.queueCompletion('["adds OTP-based login"]'); // extractor
		stub.queueCompletion(JSON.stringify([{ clause: "adds OTP-based login", matchedDirection: true }])); // matcher
		analyzer.setFootprint(["src/auth.ts"]);
		const pr = makePR();
		const bundle = makeBundle([pr]);
		const verdict = await runCheapScreen(pr, bundle, stub, analyzer);
		expect(verdict.status).toBe("clean");
	});

	it("flags when there is an orphan clause", async () => {
		stub.queueCompletion('["adds OTP login", "silently enables global rate limiting"]');
		stub.queueCompletion(JSON.stringify([
			{ clause: "adds OTP login", matchedDirection: true },
			{ clause: "silently enables global rate limiting", matchedDirection: false },
		]));
		analyzer.setFootprint(["src/auth.ts"]);
		const pr = makePR();
		const bundle = makeBundle([pr]);
		const verdict = await runCheapScreen(pr, bundle, stub, analyzer);
		expect(verdict.status).toBe("flagged");
		if (verdict.status === "flagged") {
			const signal = verdict.signals.find(s => s.kind === "effectList");
			expect(signal).toBeDefined();
		}
	});

	it("flags when a symbol is outside the expected footprint", async () => {
		stub.queueCompletion('["adds OTP login"]');
		stub.queueCompletion(JSON.stringify([{ clause: "adds OTP login", matchedDirection: true }]));
		analyzer.setFootprint(["src/auth.ts"]);
		analyzer.setSymbols([{ name: "rateLimiter", filePath: "src/middleware.ts", kind: "export" }]);
		const pr = makePR();
		const bundle = makeBundle([pr]);
		const verdict = await runCheapScreen(pr, bundle, stub, analyzer);
		expect(verdict.status).toBe("flagged");
		if (verdict.status === "flagged") {
			const signal = verdict.signals.find(s => s.kind === "footprintAnomaly");
			expect(signal).toBeDefined();
		}
	});

	it("does not return clean solely because all effects matched (INV-3)", async () => {
		// Even if all effects match, footprint anomaly still flags
		stub.queueCompletion('["adds OTP login"]');
		stub.queueCompletion(JSON.stringify([{ clause: "adds OTP login", matchedDirection: true }]));
		analyzer.setFootprint(["src/auth.ts"]);
		analyzer.setSymbols([{ name: "logger", filePath: "src/infra/logger.ts", kind: "export" }]);
		const pr = makePR();
		const bundle = makeBundle([pr]);
		const verdict = await runCheapScreen(pr, bundle, stub, analyzer);
		expect(verdict.status).toBe("flagged");
	});
});
