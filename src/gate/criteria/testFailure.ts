import type { PullRequest } from "../../types/core.js";

export function check(pr: PullRequest): { triggered: boolean; reason: string } {
	if (pr.ciStatus === "failure") {
		return { triggered: true, reason: "CI tests failed" };
	}
	return { triggered: false, reason: "" };
}
