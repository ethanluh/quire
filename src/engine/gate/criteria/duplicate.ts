import { UNDECLARED_DIRECTION, type PullRequest } from "../../types/core.js";

function hasOverlap(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
	const setA = new Set(a);
	return b.some((f) => setA.has(f));
}

export function check(
	pr: PullRequest,
	existing: ReadonlyArray<PullRequest>,
): { triggered: boolean; reason: string } {
	// Two undeclared PRs sharing the same placeholder text is not evidence they're
	// duplicates — it's the absence of a declaration, not agreement (INV-1/INV-3).
	if (pr.declaredDirection === UNDECLARED_DIRECTION) return { triggered: false, reason: "" };
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
