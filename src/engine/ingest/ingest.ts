import type { PullRequest } from "../types/core.js";
import { IncomingPRSchema, type IncomingPR } from "./schema.js";

const TEST_LINE_RE = /^\+\s*(it|test|describe)\s*\(/;
const TEST_NAME_RE = /^\+\s*(?:it|test|describe)\s*\(\s*["'`]([^"'`]+)["'`]/;
const TEST_FILE_RE = /\.(test|spec)\.[jt]sx?$/;

function extractTestNames(raw: string): ReadonlyArray<string> {
	const names: string[] = [];
	for (const line of raw.split("\n")) {
		if (TEST_LINE_RE.test(line)) {
			const m = TEST_NAME_RE.exec(line);
			if (m?.[1] !== undefined) names.push(m[1]);
		}
	}
	return names;
}

function deriveFilesTouched(hunks: IncomingPR["diff"]["hunks"]): ReadonlyArray<string> {
	return [...new Set(hunks.map((h) => h.filePath))];
}

export function normalizePR(incoming: IncomingPR): PullRequest {
	const filesTouched = incoming.filesTouched ?? deriveFilesTouched(incoming.diff.hunks);
	const testNamesChanged = extractTestNames(incoming.diff.raw);

	const filteredTestNames = testNamesChanged.filter(() =>
		filesTouched.some((f) => TEST_FILE_RE.test(f))
	);

	return {
		id: incoming.id,
		repoOwner: incoming.repoOwner,
		repoName: incoming.repoName,
		number: incoming.number,
		headSha: incoming.headSha,
		declaredDirection: incoming.declaredDirection,
		diff: incoming.diff,
		filesTouched,
		symbolsTouched: incoming.symbolsTouched ?? [],
		testNamesChanged: filteredTestNames,
		ciStatus: incoming.ciStatus,
	};
}

export function validateIncomingPayload(
	raw: unknown,
): { success: true; data: IncomingPR } | { success: false; error: string } {
	const result = IncomingPRSchema.safeParse(raw);
	if (result.success) {
		return { success: true, data: result.data };
	}
	return { success: false, error: result.error.message };
}
