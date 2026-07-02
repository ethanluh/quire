import { describe, it, expect } from "@jest/globals";
import { matchEffectsToDirection } from "../../src/engine/drift/effectList/matcher.js";
import { runCheapScreen } from "../../src/engine/drift/screen.js";
import { StubLlmProvider } from "../mocks/llmProvider.js";
import { StubStaticAnalyzer } from "../mocks/staticAnalyzer.js";
import type { Bundle, PullRequest } from "../../src/engine/types/core.js";

function makePR(overrides: Partial<PullRequest> = {}): PullRequest {
	return {
		id: "pr-1",
		repoOwner: "org",
		repoName: "repo",
		number: 1,
		headSha: "sha-1",
		declaredDirection: "add passwordless auth",
		diff: { raw: "", hunks: [] },
		filesTouched: ["src/auth.ts"],
		symbolsTouched: [],
		testNamesChanged: [],
		ciStatus: "success",
		...overrides,
	};
}

function makeBundle(members: ReadonlyArray<PullRequest>): Bundle {
	return { id: "bundle-1", direction: "add passwordless auth", effectSummary: "adds OTP-based login", members };
}

describe("matchEffectsToDirection — parses a fenced response", () => {
	it("parses a JSON array response wrapped in a markdown code fence", async () => {
		const provider = new StubLlmProvider();
		provider.queueCompletion('```json\n[{"clause": "adds OTP login", "matchedDirection": true}]\n```');

		const result = await matchEffectsToDirection(["adds OTP login"], "add passwordless auth", provider);

		expect(result).toEqual([{ clause: "adds OTP login", matchedDirection: true }]);
	});
});

describe("matchEffectsToDirection — parse-failure fallback (INV-3)", () => {
	it("treats every clause as an orphan when the response is not parseable JSON", async () => {
		const provider = new StubLlmProvider();
		provider.queueCompletion("not valid json at all");

		const result = await matchEffectsToDirection(
			["adds rate limiting to login endpoint"],
			"add passwordless auth",
			provider,
		);

		expect(result).toEqual([
			{ clause: "adds rate limiting to login endpoint", matchedDirection: false },
		]);
	});

	it("treats every clause as an orphan when the parsed array has the wrong length", async () => {
		const provider = new StubLlmProvider();
		provider.queueCompletion(JSON.stringify([{ clause: "only one", matchedDirection: true }]));

		const result = await matchEffectsToDirection(
			["effect one", "effect two"],
			"add passwordless auth",
			provider,
		);

		expect(result).toEqual([
			{ clause: "effect one", matchedDirection: false },
			{ clause: "effect two", matchedDirection: false },
		]);
	});

	it("never reports matchedDirection: true on a parse failure (would silently clear per INV-3)", async () => {
		const provider = new StubLlmProvider();
		provider.queueCompletion("{ truncated");

		const result = await matchEffectsToDirection(["effect"], "direction", provider);

		expect(result.every((e) => e.matchedDirection === false)).toBe(true);
	});
});

describe("runCheapScreen — screen failure must flag, never clear (INV-3)", () => {
	it("flags the member when the matcher's response fails to parse", async () => {
		const provider = new StubLlmProvider();
		provider.queueCompletion("garbage, not json"); // matcher response — fails to parse

		const analyzer = new StubStaticAnalyzer();
		analyzer.setSymbols([]);
		analyzer.setFootprint(["src/auth.ts"]);

		const pr = makePR();
		const bundle = makeBundle([pr]);

		const verdict = await runCheapScreen(pr, bundle, ["adds rate limiting to login endpoint"], provider, analyzer);

		expect(verdict.status).toBe("flagged");
		if (verdict.status === "flagged") {
			expect(verdict.signals).toEqual([
				{ kind: "effectList", prId: "pr-1", orphanClauses: ["adds rate limiting to login endpoint"] },
			]);
		}
	});
});
