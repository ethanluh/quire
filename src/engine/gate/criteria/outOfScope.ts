import { UNDECLARED_DIRECTION, type PullRequest } from "../../types/core.js";

export function check(
	pr: PullRequest,
	scopeKeywords: ReadonlyArray<string>,
): { triggered: boolean; reason: string } {
	if (scopeKeywords.length === 0) return { triggered: false, reason: "" };
	// With no real declaration there's nothing to test scope keywords against — flagging
	// it here would always fire, which isn't a scope judgment, just an artifact of the
	// placeholder text never containing a keyword.
	if (pr.declaredDirection === UNDECLARED_DIRECTION) return { triggered: false, reason: "" };
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
