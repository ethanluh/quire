import { describe, it, expect } from "@jest/globals";
import { matchRiskTaxonomy } from "../../src/engine/judge/riskTaxonomy.js";
import type { Bundle, PullRequest } from "../../src/engine/types/core.js";
import type { CompiledRiskTaxonomyEntry } from "../../src/engine/types/judge.js";

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

const TAXONOMY: ReadonlyArray<CompiledRiskTaxonomyEntry> = [
	{ id: "auth", label: "Auth", description: "d", filePatterns: [/(?:^|\/)auth\//i] },
	{ id: "migration", label: "Migration", description: "d", filePatterns: [/(?:^|\/)migrations?\//i, /\.sql$/i] },
	{ id: "unclear-revert-path", label: "Unclear revert path", description: "d", filePatterns: [] },
];

describe("matchRiskTaxonomy", () => {
	it("matches an entry whose pattern hits a touched file", () => {
		const bundle = makeBundle([makePr({ filesTouched: ["src/auth/session.ts"] })]);
		expect(matchRiskTaxonomy(bundle, TAXONOMY)).toEqual(["auth"]);
	});

	it("matches multiple entries independently", () => {
		const bundle = makeBundle([makePr({ filesTouched: ["src/auth/session.ts", "migrations/0001_init.sql"] })]);
		const matches = matchRiskTaxonomy(bundle, TAXONOMY);
		expect(matches).toContain("auth");
		expect(matches).toContain("migration");
	});

	it("matches a migration entry via either of its patterns", () => {
		const bundle = makeBundle([makePr({ filesTouched: ["db/schema.sql"] })]);
		expect(matchRiskTaxonomy(bundle, TAXONOMY)).toEqual(["migration"]);
	});

	it("returns no matches for an unremarkable bundle", () => {
		const bundle = makeBundle([makePr({ filesTouched: ["src/widgets/button.ts"] })]);
		expect(matchRiskTaxonomy(bundle, TAXONOMY)).toEqual([]);
	});

	it("checks files across every member, not just the first", () => {
		const bundle = makeBundle([
			makePr({ id: "pr-1", filesTouched: ["src/widgets/button.ts"] }),
			makePr({ id: "pr-2", filesTouched: ["src/auth/login.ts"] }),
		]);
		expect(matchRiskTaxonomy(bundle, TAXONOMY)).toEqual(["auth"]);
	});

	it("never matches an entry with no file patterns (judge-reasoning-only taxonomy entries)", () => {
		const bundle = makeBundle([makePr({ filesTouched: ["src/anything/at/all.ts"] })]);
		expect(matchRiskTaxonomy(bundle, TAXONOMY)).not.toContain("unclear-revert-path");
	});

	it("does not false-positive on a substring match outside a path segment boundary", () => {
		const bundle = makeBundle([makePr({ filesTouched: ["src/author/profile.ts"] })]);
		expect(matchRiskTaxonomy(bundle, TAXONOMY)).toEqual([]);
	});
});
