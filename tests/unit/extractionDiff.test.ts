import { describe, it, expect } from "@jest/globals";
import {
	buildExtractionDiff,
	DIFF_TRUNCATED_MARKER,
	MAX_EXTRACTION_DIFF_CHARS,
} from "../../src/engine/drift/effectList/extractionDiff.js";
import type { Diff } from "../../src/engine/types/core.js";

function fileSection(path: string, line: string): string {
	return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -0,0 +1 @@\n+${line}\n`;
}

function makeDiff(raw: string): Diff {
	return { raw, hunks: [] };
}

describe("buildExtractionDiff", () => {
	it("passes a plain source diff through unchanged", () => {
		const raw = fileSection("src/auth.ts", "export function login() {}");
		const { text, skippedFiles, truncated } = buildExtractionDiff(makeDiff(raw));
		expect(text).toBe(raw);
		expect(skippedFiles).toEqual([]);
		expect(truncated).toBe(false);
	});

	it("drops lockfile and generated-file sections, noting what was omitted", () => {
		const source = fileSection("src/auth.ts", "export function login() {}");
		const raw =
			source +
			fileSection("package-lock.json", '"lockfileVersion": 3') +
			fileSection("dist/bundle.min.js", "!function(){}") +
			fileSection("app/assets/main.map", "{}");
		const { text, skippedFiles } = buildExtractionDiff(makeDiff(raw));
		expect(text).toContain("src/auth.ts");
		expect(text).not.toContain("lockfileVersion");
		expect(text).not.toContain("!function");
		expect(skippedFiles).toEqual(["package-lock.json", "dist/bundle.min.js", "app/assets/main.map"]);
		expect(text).toContain("3 lockfile/generated file(s) omitted");
	});

	it("does not skip a source file whose name merely contains a lockfile-like substring", () => {
		const raw = fileSection("src/lockfileParser.ts", "export function parse() {}");
		const { text, skippedFiles } = buildExtractionDiff(makeDiff(raw));
		expect(text).toContain("lockfileParser");
		expect(skippedFiles).toEqual([]);
	});

	it("truncates an oversized diff at the cap with an explicit marker", () => {
		const big = fileSection("src/generated-but-not-matching.ts", "x".repeat(MAX_EXTRACTION_DIFF_CHARS * 2));
		const { text, truncated } = buildExtractionDiff(makeDiff(big));
		expect(truncated).toBe(true);
		expect(text).toContain(DIFF_TRUNCATED_MARKER);
		// Cap plus the marker line — not the raw multiple of the cap.
		expect(text.length).toBeLessThan(MAX_EXTRACTION_DIFF_CHARS + DIFF_TRUNCATED_MARKER.length + 2);
	});
});
