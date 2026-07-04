import { describe, it, expect } from "@jest/globals";
import { resolveSemanticHunks } from "../../src/engine/queue/semanticHunkResolver.js";
import { StubLlmProvider } from "../../src/engine/drift/effectList/stubProvider.js";
import { extractConflictHunks, extractConflictRegions } from "../../src/engine/queue/conflictHunks.js";
import type { ConflictHunk } from "../../src/engine/queue/conflictHunks.js";

function makeHunk(index: number, overrides: Partial<ConflictHunk> = {}): ConflictHunk {
	return {
		index,
		baseLines: ["base"],
		oursLines: ["ours"],
		theirsLines: ["theirs"],
		...overrides,
	};
}

describe("resolveSemanticHunks", () => {
	it("returns an empty array without calling the provider when there are no hunks", async () => {
		const provider = new StubLlmProvider();
		const result = await resolveSemanticHunks([], "add passwordless auth", provider);
		expect(result).toEqual([]);
		expect(provider.calls).toHaveLength(0);
	});

	it("maps each hunk_id back to its own hunk in order, honoring the model's confidence", async () => {
		const provider = new StubLlmProvider();
		provider.queueCompletion(
			JSON.stringify([
				{ hunk_id: 1, resolution: "resolved-1", confidence: "high" },
				{ hunk_id: 2, resolution: "resolved-2", confidence: "low" },
			]),
		);

		const result = await resolveSemanticHunks([makeHunk(0), makeHunk(5)], "add passwordless auth", provider);

		expect(result).toEqual([
			{ resolution: "resolved-1", confidence: "high" },
			{ resolution: "resolved-2", confidence: "low" },
		]);
	});

	it("fails a hunk closed to low confidence when it's still missing after every retry, disclosing why", async () => {
		const provider = new StubLlmProvider();
		provider.queueCompletion(JSON.stringify([{ hunk_id: 1, resolution: "resolved-1", confidence: "high" }]));

		const result = await resolveSemanticHunks(
			[makeHunk(0, { oursLines: ["ours-1"] }), makeHunk(1, { oursLines: ["ours-2"] })],
			"add passwordless auth",
			provider,
		);

		expect(result).toEqual([
			{ resolution: "resolved-1", confidence: "high" },
			{ resolution: "ours-2", confidence: "low", reason: expect.stringContaining("missing a resolution for hunk_id 2") },
		]);
	});

	it("fails every hunk closed to low confidence, disclosing why, when the response is never valid JSON", async () => {
		const provider = new StubLlmProvider();
		provider.queueCompletion("not json at all");

		const result = await resolveSemanticHunks([makeHunk(0, { oursLines: ["ours-1"] })], "add passwordless auth", provider);

		// The stub returns "[]" (a valid, empty array) once its queue is exhausted, so the
		// final disclosed reason is "still missing" rather than the original parse error —
		// that's still an accurate, actionable disclosure of the residual state.
		expect(result).toEqual([{ resolution: "ours-1", confidence: "low", reason: expect.stringContaining("missing a resolution for hunk_id 1") }]);
	});

	it("fails every hunk closed to low confidence, disclosing why, when the response is never a JSON array", async () => {
		const provider = new StubLlmProvider();
		provider.queueCompletion(JSON.stringify({ not: "an array" }));

		const result = await resolveSemanticHunks([makeHunk(0, { oursLines: ["ours-1"] })], "add passwordless auth", provider);

		expect(result).toEqual([{ resolution: "ours-1", confidence: "low", reason: expect.stringContaining("missing a resolution for hunk_id 1") }]);
	});

	it("retries (without conversational feedback) when the model call itself throws, then succeeds", async () => {
		const provider = new StubLlmProvider();
		let calls = 0;
		provider.complete = async () => {
			calls++;
			if (calls === 1) throw new Error("connection reset");
			return JSON.stringify([{ hunk_id: 1, resolution: "resolved-1", confidence: "high" }]);
		};

		const result = await resolveSemanticHunks([makeHunk(0)], "add passwordless auth", provider);

		expect(result).toEqual([{ resolution: "resolved-1", confidence: "high" }]);
		expect(calls).toBe(2);
	});

	it("fails closed disclosing the transport error when the model call throws on every attempt", async () => {
		const provider = new StubLlmProvider();
		provider.complete = async () => {
			throw new Error("connection reset");
		};

		const result = await resolveSemanticHunks([makeHunk(0, { oursLines: ["ours-1"] })], "add passwordless auth", provider);

		expect(result).toEqual([{ resolution: "ours-1", confidence: "low", reason: expect.stringContaining("connection reset") }]);
	});

	it("retries with specific feedback after unparseable JSON, then succeeds", async () => {
		const provider = new StubLlmProvider();
		provider.queueCompletion("not json at all");
		provider.queueCompletion(JSON.stringify([{ hunk_id: 1, resolution: "resolved-1", confidence: "high" }]));

		const result = await resolveSemanticHunks([makeHunk(0)], "add passwordless auth", provider);

		expect(result).toEqual([{ resolution: "resolved-1", confidence: "high" }]);
		expect(provider.calls).toHaveLength(2);
		const secondCallMessages = provider.calls[1]?.messages ?? [];
		expect(secondCallMessages.at(-1)?.content).toContain("was not valid JSON");
	});

	it("retries with specific feedback when a resolution still contains conflict markers, then succeeds", async () => {
		const provider = new StubLlmProvider();
		provider.queueCompletion(
			JSON.stringify([{ hunk_id: 1, resolution: "<<<<<<< ours\nfoo\n=======\nbar\n>>>>>>> theirs", confidence: "high" }]),
		);
		provider.queueCompletion(JSON.stringify([{ hunk_id: 1, resolution: "resolved-1", confidence: "high" }]));

		const result = await resolveSemanticHunks([makeHunk(0)], "add passwordless auth", provider);

		expect(result).toEqual([{ resolution: "resolved-1", confidence: "high" }]);
		expect(provider.calls).toHaveLength(2);
		const secondCallMessages = provider.calls[1]?.messages ?? [];
		expect(secondCallMessages.at(-1)?.content).toContain("still contains git conflict marker lines");
	});

	it("keeps a hunk resolved by an earlier attempt instead of re-requesting it on retry", async () => {
		const provider = new StubLlmProvider();
		// Only hunk_id 1 comes back valid; hunk_id 2 is missing entirely.
		provider.queueCompletion(JSON.stringify([{ hunk_id: 1, resolution: "resolved-1", confidence: "high" }]));
		provider.queueCompletion(
			JSON.stringify([
				{ hunk_id: 1, resolution: "should-be-ignored", confidence: "low" },
				{ hunk_id: 2, resolution: "resolved-2", confidence: "high" },
			]),
		);

		const result = await resolveSemanticHunks(
			[makeHunk(0, { oursLines: ["ours-1"] }), makeHunk(1, { oursLines: ["ours-2"] })],
			"add passwordless auth",
			provider,
		);

		// Hunk 1 keeps its first-attempt (high-confidence) resolution rather than being
		// overwritten by the second attempt's low-confidence one for the same hunk_id.
		expect(result).toEqual([
			{ resolution: "resolved-1", confidence: "high" },
			{ resolution: "resolved-2", confidence: "high" },
		]);
	});

	describe("syntax gate", () => {
		function fileContext(ours: string, base: string, theirs: string, path = "src/auth.ts") {
			const regions = extractConflictRegions(ours, base, theirs);
			const hunks = extractConflictHunks(regions);
			return { hunks, syntaxContext: { path, regions, mechanicalResolutions: new Map<number, string>() } };
		}

		it("retries with the parse error as feedback when the combined file doesn't parse, then succeeds", async () => {
			const { hunks, syntaxContext } = fileContext("a\nb-A\nc", "a\nb\nc", "a\nb-B\nc");
			const provider = new StubLlmProvider();
			provider.queueCompletion(JSON.stringify([{ hunk_id: 1, resolution: "function broken( {", confidence: "high" }]));
			provider.queueCompletion(JSON.stringify([{ hunk_id: 1, resolution: "b-merged", confidence: "high" }]));

			const result = await resolveSemanticHunks(hunks, "add passwordless auth", provider, syntaxContext);

			expect(result).toEqual([{ resolution: "b-merged", confidence: "high" }]);
			expect(provider.calls).toHaveLength(2);
			const secondCallMessages = provider.calls[1]?.messages ?? [];
			expect(secondCallMessages.at(-1)?.content).toContain("does not parse as valid code");
		});

		it("fails closed to low confidence for every hunk when the file still doesn't parse after every retry", async () => {
			const { hunks, syntaxContext } = fileContext("a\nb-A\nc", "a\nb\nc", "a\nb-B\nc");
			const provider = new StubLlmProvider();
			const badResponse = JSON.stringify([{ hunk_id: 1, resolution: "function broken( {", confidence: "high" }]);
			provider.queueCompletion(badResponse);
			provider.queueCompletion(badResponse);
			provider.queueCompletion(badResponse);

			const result = await resolveSemanticHunks(hunks, "add passwordless auth", provider, syntaxContext);

			expect(result).toEqual([
				{ resolution: "b-A", confidence: "low", reason: expect.stringContaining("does not parse as valid code") },
			]);
			expect(provider.calls).toHaveLength(3);
		});

		it("passes a syntactically valid combined file through without extra calls", async () => {
			const { hunks, syntaxContext } = fileContext("a\nb-A\nc", "a\nb\nc", "a\nb-B\nc");
			const provider = new StubLlmProvider();
			provider.queueCompletion(JSON.stringify([{ hunk_id: 1, resolution: "b-merged", confidence: "high" }]));

			const result = await resolveSemanticHunks(hunks, "add passwordless auth", provider, syntaxContext);

			expect(result).toEqual([{ resolution: "b-merged", confidence: "high" }]);
			expect(provider.calls).toHaveLength(1);
		});
	});
});
