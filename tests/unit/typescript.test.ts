import { describe, it, expect } from "@jest/globals";
import { TypeScriptAnalyzer } from "../../src/engine/drift/footprint/typescript.js";
import type { Bundle, Diff, PullRequest } from "../../src/engine/types/core.js";

function diffFromHunk(filePath: string, additions: string[], deletions: string[] = []): Diff {
	return { raw: "", hunks: [{ filePath, additions, deletions }] };
}

function makePR(id: string, filesTouched: string[]): PullRequest {
	return {
		id, repoOwner: "org", repoName: "repo", number: 1,
		headSha: `sha-${id}`,
		declaredDirection: "add passwordless auth",
		directionInferred: false,
		diff: { raw: "", hunks: [] },
		filesTouched,
		labels: [], assignees: [],
		symbolsTouched: [], testNamesChanged: [], ciStatus: "success",
	};
}

describe("TypeScriptAnalyzer.computeExpectedFootprint — leave-one-out", () => {
	const analyzer = new TypeScriptAnalyzer();

	it("excludes the screened member's own files — only the other members define the expected footprint", async () => {
		const bundle: Bundle = {
			id: "bundle-1", direction: "add passwordless auth", directionInferred: false,
			effectSummary: "",
			members: [makePR("pr-a", ["src/auth.ts", "src/otp.ts"]), makePR("pr-b", ["src/auth.ts", "src/rogue.ts"])],
		};
		// Screening pr-b: pr-b's own src/rogue.ts must NOT be in the expected set (a
		// footprint that includes the screened member's own files makes every touch
		// "expected" by construction and the anomaly signal a structural no-op).
		const expected = await analyzer.computeExpectedFootprint(bundle, "pr-b");
		expect([...expected].sort()).toEqual(["src/auth.ts", "src/otp.ts"]);
	});
});

describe("TypeScriptAnalyzer.analyzeSymbolTouches", () => {
	const analyzer = new TypeScriptAnalyzer();

	it("tags an added export as operation \"add\"", async () => {
		const diff = diffFromHunk("src/helper.ts", ["+export function helper() {}"]);
		const touches = await analyzer.analyzeSymbolTouches(diff);
		expect(touches).toEqual([{ name: "helper", filePath: "src/helper.ts", kind: "export", operation: "add" }]);
	});

	it("tags a removed export as operation \"remove\"", async () => {
		const diff = diffFromHunk("src/helper.ts", [], ["-export function helper() {}"]);
		const touches = await analyzer.analyzeSymbolTouches(diff);
		expect(touches).toEqual([{ name: "helper", filePath: "src/helper.ts", kind: "export", operation: "remove" }]);
	});

	it("tags named-import identifiers as operation \"reference\", stripping aliases", async () => {
		const diff = diffFromHunk("src/consumer.ts", ["+import { helper, other as aliased } from './helper';"]);
		const touches = await analyzer.analyzeSymbolTouches(diff);
		expect(touches).toEqual([
			{ name: "helper", filePath: "src/consumer.ts", kind: "variable", operation: "reference" },
			{ name: "other", filePath: "src/consumer.ts", kind: "variable", operation: "reference" },
		]);
	});

	it("strips an inline per-specifier \"type\" modifier, with or without an alias", async () => {
		const diff = diffFromHunk("src/consumer.ts", ["+import { type Foo, type Bar as Baz } from './helper';"]);
		const touches = await analyzer.analyzeSymbolTouches(diff);
		expect(touches).toEqual([
			{ name: "Foo", filePath: "src/consumer.ts", kind: "variable", operation: "reference" },
			{ name: "Bar", filePath: "src/consumer.ts", kind: "variable", operation: "reference" },
		]);
	});

	it("tags a default-import identifier as operation \"reference\"", async () => {
		const diff = diffFromHunk("src/consumer.ts", ["+import Helper from './helper';"]);
		const touches = await analyzer.analyzeSymbolTouches(diff);
		expect(touches).toEqual([{ name: "Helper", filePath: "src/consumer.ts", kind: "variable", operation: "reference" }]);
	});

	it("does not emit a rename operation in v1 (no pairing heuristic)", async () => {
		const diff = diffFromHunk("src/helper.ts", ["+export function helperV2() {}"], ["-export function helper() {}"]);
		const touches = await analyzer.analyzeSymbolTouches(diff);
		expect(touches.map((t) => t.operation)).not.toContain("rename");
		expect(touches).toEqual([
			{ name: "helperV2", filePath: "src/helper.ts", kind: "export", operation: "add" },
			{ name: "helper", filePath: "src/helper.ts", kind: "export", operation: "remove" },
		]);
	});

	it("returns no touches for an unrelated line", async () => {
		const diff = diffFromHunk("src/helper.ts", ["+const unrelated = 1;"]);
		const touches = await analyzer.analyzeSymbolTouches(diff);
		expect(touches).toEqual([]);
	});
});
