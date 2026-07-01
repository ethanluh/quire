import { describe, it, expect } from "@jest/globals";
import { parseUnifiedDiff } from "../../src/engine/github/diffParser.js";

describe("parseUnifiedDiff", () => {
	it("groups additions and deletions into hunks per file", () => {
		const raw = [
			"diff --git a/src/auth.ts b/src/auth.ts",
			"index 111..222 100644",
			"--- a/src/auth.ts",
			"+++ b/src/auth.ts",
			"@@ -1,2 +1,2 @@",
			"-export function oldLogin() {}",
			"+export function login() {}",
			" export const unrelated = 1;",
		].join("\n");

		const hunks = parseUnifiedDiff(raw);

		expect(hunks).toEqual([
			{
				filePath: "src/auth.ts",
				additions: ["+export function login() {}"],
				deletions: ["-export function oldLogin() {}"],
			},
		]);
	});

	it("splits multiple hunks in the same file into separate entries", () => {
		const raw = [
			"diff --git a/src/auth.ts b/src/auth.ts",
			"--- a/src/auth.ts",
			"+++ b/src/auth.ts",
			"@@ -1,1 +1,1 @@",
			"+export function login() {}",
			"@@ -10,1 +10,1 @@",
			"+export function logout() {}",
		].join("\n");

		const hunks = parseUnifiedDiff(raw);

		expect(hunks).toEqual([
			{ filePath: "src/auth.ts", additions: ["+export function login() {}"], deletions: [] },
			{ filePath: "src/auth.ts", additions: ["+export function logout() {}"], deletions: [] },
		]);
	});

	it("tracks hunks across multiple files", () => {
		const raw = [
			"diff --git a/src/auth.ts b/src/auth.ts",
			"--- a/src/auth.ts",
			"+++ b/src/auth.ts",
			"@@ -1,1 +1,1 @@",
			"+export function login() {}",
			"diff --git a/src/db.ts b/src/db.ts",
			"--- a/src/db.ts",
			"+++ b/src/db.ts",
			"@@ -1,1 +1,1 @@",
			"+export function connect() {}",
		].join("\n");

		const hunks = parseUnifiedDiff(raw);

		expect(hunks.map((h) => h.filePath)).toEqual(["src/auth.ts", "src/db.ts"]);
	});

	it("returns no hunks for an empty diff", () => {
		expect(parseUnifiedDiff("")).toEqual([]);
	});

	it("correctly attributes hunks for a file path containing the literal substring \" b/\"", () => {
		// The `diff --git a/X b/Y` header concatenates both paths with no delimiter, so a
		// path like "src/a b/c.ts" makes that line ambiguous — the file path must come
		// from the unambiguous `--- a/...` / `+++ b/...` lines instead.
		const raw = [
			"diff --git a/src/a b/c.ts b/src/a b/c.ts",
			"--- a/src/a b/c.ts",
			"+++ b/src/a b/c.ts",
			"@@ -1,1 +1,1 @@",
			"+export function weird() {}",
		].join("\n");

		const hunks = parseUnifiedDiff(raw);

		expect(hunks).toEqual([
			{ filePath: "src/a b/c.ts", additions: ["+export function weird() {}"], deletions: [] },
		]);
	});

	it("attributes a deleted file's hunk to its old path via the --- a/... line", () => {
		const raw = [
			"diff --git a/src/gone.ts b/src/gone.ts",
			"--- a/src/gone.ts",
			"+++ /dev/null",
			"@@ -1,1 +0,0 @@",
			"-export function gone() {}",
		].join("\n");

		const hunks = parseUnifiedDiff(raw);

		expect(hunks).toEqual([
			{ filePath: "src/gone.ts", additions: [], deletions: ["-export function gone() {}"] },
		]);
	});

	it("attributes a renamed file's hunk to its new path via the +++ b/... line", () => {
		const raw = [
			"diff --git a/src/old-name.ts b/src/new-name.ts",
			"--- a/src/old-name.ts",
			"+++ b/src/new-name.ts",
			"@@ -1,1 +1,1 @@",
			"+export function renamed() {}",
		].join("\n");

		const hunks = parseUnifiedDiff(raw);

		expect(hunks).toEqual([
			{ filePath: "src/new-name.ts", additions: ["+export function renamed() {}"], deletions: [] },
		]);
	});
});
