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
});
