import type { PullRequest } from "../../types/core.js";

function hasOverlap(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
	const setA = new Set(a);
	return b.some((f) => setA.has(f));
}

export function check(
	pr: PullRequest,
	existing: ReadonlyArray<PullRequest>,
): { triggered: boolean; reason: string } {
	const candidate = existing.find(
		(e) =>
			e.id !== pr.id &&
			e.declaredDirection === pr.declaredDirection &&
			hasOverlap(e.filesTouched, pr.filesTouched),
	);
	if (candidate !== undefined) {
		return { triggered: true, reason: `Duplicate of PR ${candidate.id}` };
	}
	return { triggered: false, reason: "" };
}
