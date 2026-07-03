import { describe, it, expect } from "@jest/globals";
import { resolveSemanticHunks } from "../../src/engine/queue/semanticHunkResolver.js";
import { StubLlmProvider } from "../../src/engine/drift/effectList/stubProvider.js";
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

	it("fails a hunk closed to low confidence when it's missing from the model's response", async () => {
		const provider = new StubLlmProvider();
		provider.queueCompletion(JSON.stringify([{ hunk_id: 1, resolution: "resolved-1", confidence: "high" }]));

		const result = await resolveSemanticHunks(
			[makeHunk(0, { oursLines: ["ours-1"] }), makeHunk(1, { oursLines: ["ours-2"] })],
			"add passwordless auth",
			provider,
		);

		expect(result).toEqual([
			{ resolution: "resolved-1", confidence: "high" },
			{ resolution: "ours-2", confidence: "low" },
		]);
	});

	it("fails every hunk closed to low confidence when the response isn't valid JSON", async () => {
		const provider = new StubLlmProvider();
		provider.queueCompletion("not json at all");

		const result = await resolveSemanticHunks([makeHunk(0, { oursLines: ["ours-1"] })], "add passwordless auth", provider);

		expect(result).toEqual([{ resolution: "ours-1", confidence: "low" }]);
	});

	it("fails every hunk closed to low confidence when the response isn't a JSON array", async () => {
		const provider = new StubLlmProvider();
		provider.queueCompletion(JSON.stringify({ not: "an array" }));

		const result = await resolveSemanticHunks([makeHunk(0, { oursLines: ["ours-1"] })], "add passwordless auth", provider);

		expect(result).toEqual([{ resolution: "ours-1", confidence: "low" }]);
	});
});
