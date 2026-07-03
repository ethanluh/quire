import { describe, it, expect } from "@jest/globals";
import { classifyBestMatch } from "../../src/engine/drift/effectList/clusterClassifier.js";
import { StubLlmProvider } from "../mocks/llmProvider.js";

describe("classifyBestMatch — skips the LLM call when there's nothing to compare", () => {
	it("returns -1 without calling complete() when there are no existing centroids", async () => {
		const provider = new StubLlmProvider();
		const result = await classifyBestMatch("adds OTP login", [], provider);

		expect(result).toBe(-1);
		expect(provider.calls).toHaveLength(0);
	});

	it("returns -1 without calling complete() when the PR's effect text is empty", async () => {
		const provider = new StubLlmProvider();
		const result = await classifyBestMatch("", ["adds OTP login"], provider);

		expect(result).toBe(-1);
		expect(provider.calls).toHaveLength(0);
	});

	it("returns -1 without calling complete() when the PR's effect text is whitespace-only", async () => {
		const provider = new StubLlmProvider();
		const result = await classifyBestMatch("   ", ["adds OTP login"], provider);

		expect(result).toBe(-1);
		expect(provider.calls).toHaveLength(0);
	});
});

describe("classifyBestMatch — parses the model's chosen index", () => {
	it("returns the 0-based index of the 1-based number the model names", async () => {
		const provider = new StubLlmProvider();
		provider.queueCompletion("2");

		const result = await classifyBestMatch(
			"adds passkey support",
			["migrates database connection pooling", "adds OTP-based login flow"],
			provider,
		);

		expect(result).toBe(1);
	});

	it("returns -1 when the model reports 0 (no match)", async () => {
		const provider = new StubLlmProvider();
		provider.queueCompletion("0");

		const result = await classifyBestMatch("adds passkey support", ["migrates database connection pooling"], provider);

		expect(result).toBe(-1);
	});

	it("parses a number wrapped in a code fence or surrounding prose", async () => {
		const provider = new StubLlmProvider();
		provider.queueCompletion("```\n1\n```");

		const result = await classifyBestMatch("adds passkey support", ["adds OTP-based login flow"], provider);

		expect(result).toBe(0);
	});
});

describe("classifyBestMatch — fails closed on an unusable response (mirrors matcher.ts's INV-3 posture)", () => {
	it("returns -1 when the response has no parseable number", async () => {
		const provider = new StubLlmProvider();
		provider.queueCompletion("not a number at all");

		const result = await classifyBestMatch("adds passkey support", ["adds OTP-based login flow"], provider);

		expect(result).toBe(-1);
	});

	it("returns -1 when the number is out of range", async () => {
		const provider = new StubLlmProvider();
		provider.queueCompletion("5");

		const result = await classifyBestMatch("adds passkey support", ["adds OTP-based login flow"], provider);

		expect(result).toBe(-1);
	});

	it("returns -1 for a negative number", async () => {
		const provider = new StubLlmProvider();
		provider.queueCompletion("-1");

		const result = await classifyBestMatch("adds passkey support", ["adds OTP-based login flow"], provider);

		expect(result).toBe(-1);
	});
});
