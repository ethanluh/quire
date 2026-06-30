import type { PullRequest } from "../../types/core.js";

export function check(
	pr: PullRequest,
	scopeKeywords: ReadonlyArray<string>,
): { triggered: boolean; reason: string } {
	if (scopeKeywords.length === 0) return { triggered: false, reason: "" };
	const direction = pr.declaredDirection.toLowerCase();
	const matched = scopeKeywords.some((kw) => direction.includes(kw.toLowerCase()));
	if (!matched) {
		return {
			triggered: true,
			reason: `Declared direction does not match any scope keyword: ${scopeKeywords.join(", ")}`,
		};
	}
	return { triggered: false, reason: "" };
}
