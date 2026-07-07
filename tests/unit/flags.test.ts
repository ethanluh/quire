import { describe, it, expect } from "@jest/globals";
import { detectFlags, isHighRisk, HIGH_RISK_FLAGS } from "../../src/engine/review/flags.js";
import type { Bundle, PullRequest } from "../../src/engine/types/core.js";

function makePr(overrides: Partial<PullRequest> = {}): PullRequest {
	return {
		id: "pr-1",
		repoOwner: "org",
		repoName: "repo",
		number: 1,
		headSha: "sha-1",
		declaredDirection: "add passwordless auth",
		directionInferred: false,
		diff: { raw: "", hunks: [] },
		filesTouched: [],
		symbolsTouched: [],
		testNamesChanged: [],
		ciStatus: "success",
		...overrides,
	};
}

function makeBundle(members: ReadonlyArray<PullRequest>): Bundle {
	return {
		id: "bundle-1",
		direction: "add passwordless auth",
		directionInferred: false,
		effectSummary: "adds OTP-based login",
		members,
	};
}

describe("detectFlags", () => {
	it("flags a bundle touching an auth directory", () => {
		const bundle = makeBundle([makePr({ filesTouched: ["src/auth/session.ts"] })]);
		expect(detectFlags(bundle)).toContain("touches auth");
	});

	it("does not flag auth on files that merely contain 'auth' as a substring", () => {
		const bundle = makeBundle([makePr({ filesTouched: ["src/author.ts", "src/sessionize.ts"] })]);
		expect(detectFlags(bundle)).not.toContain("touches auth");
	});

	it("flags a bundle touching shared infra", () => {
		const bundle = makeBundle([makePr({ filesTouched: [".github/workflows/deploy.yml"] })]);
		expect(detectFlags(bundle)).toContain("touches shared infra");
	});

	it("flags a bundle spanning multiple repos", () => {
		const bundle = makeBundle([
			makePr({ id: "pr-1", repoOwner: "org", repoName: "repo-a" }),
			makePr({ id: "pr-2", repoOwner: "org", repoName: "repo-b" }),
		]);
		expect(detectFlags(bundle)).toContain("spans multiple repos");
	});

	it("does not flag multi-repo for members that share a repo", () => {
		const bundle = makeBundle([
			makePr({ id: "pr-1", repoOwner: "org", repoName: "repo-a" }),
			makePr({ id: "pr-2", repoOwner: "org", repoName: "repo-a" }),
		]);
		expect(detectFlags(bundle)).not.toContain("spans multiple repos");
	});

	it("flags neither auth, infra, nor multi-repo for an unremarkable bundle", () => {
		const bundle = makeBundle([makePr({ filesTouched: ["src/widgets/button.ts"] })]);
		const flags = detectFlags(bundle);
		for (const flag of HIGH_RISK_FLAGS) {
			expect(flags).not.toContain(flag);
		}
	});
});

describe("isHighRisk", () => {
	it("is true when any high-risk flag is present", () => {
		expect(isHighRisk(["touches public API", "touches auth"])).toBe(true);
	});

	it("is false when only informational flags are present", () => {
		expect(isHighRisk(["touches public API", "contains migration"])).toBe(false);
	});

	it("is false for no flags", () => {
		expect(isHighRisk([])).toBe(false);
	});
});
