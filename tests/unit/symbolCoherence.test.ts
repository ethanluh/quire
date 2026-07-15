import { describe, it, expect } from "@jest/globals";
import { findSymbolInconsistencies } from "../../src/engine/drift/symbolCoherence/check.js";
import type { Bundle, PullRequest, SymbolTouch } from "../../src/engine/types/core.js";

const EMPTY_DIFF = { raw: "", hunks: [] };

function makePR(id: string): PullRequest {
	return {
		id, repoOwner: "org", repoName: "repo", number: 1,
		headSha: `sha-${id}`,
		declaredDirection: "add passwordless auth",
		directionInferred: false,
		diff: EMPTY_DIFF, filesTouched: [`src/${id}.ts`],
		labels: [], assignees: [],
		symbolsTouched: [], testNamesChanged: [], ciStatus: "success",
	};
}

function touch(operation: SymbolTouch["operation"]): SymbolTouch {
	return { name: "helper", filePath: "src/helper.ts", kind: "export", operation };
}

function makeBundle(memberIds: string[]): Bundle {
	return {
		id: "bundle-1", direction: "add passwordless auth", directionInferred: false,
		effectSummary: "adds OTP-based login", members: memberIds.map(makePR),
	};
}

describe("findSymbolInconsistencies", () => {
	it("flags the classic add / remove / reference triple", () => {
		const bundle = makeBundle(["pr-A", "pr-B", "pr-C"]);
		const touchesByPr = new Map([
			["pr-A", [touch("add")]],
			["pr-B", [touch("remove")]],
			["pr-C", [touch("reference")]],
		]);

		const signals = findSymbolInconsistencies(bundle, touchesByPr);

		const prIds = new Set(signals.map((s) => s.prId));
		expect(prIds).toEqual(new Set(["pr-B", "pr-C"]));
		for (const s of signals) {
			expect(s.kind).toBe("symbolInconsistency");
			if (s.kind === "symbolInconsistency") {
				expect(s.symbol.name).toBe("helper");
				expect(s.touchedBy).toHaveLength(3);
			}
		}
	});

	it("does not false-positive on a 2-PR add + reference of a still-valid name", () => {
		const bundle = makeBundle(["pr-A", "pr-C"]);
		const touchesByPr = new Map([
			["pr-A", [touch("add")]],
			["pr-C", [touch("reference")]],
		]);

		expect(findSymbolInconsistencies(bundle, touchesByPr)).toEqual([]);
	});

	it("still flags when a 4th member also adds the name (no reconciliation guard, by design)", () => {
		// A bare "add" from another member can't be told apart from "this PR originally
		// introduced the name" vs. "this PR restores what a sibling just removed" — both are
		// indistinguishable add touches with no causal link to the removal (see check.ts's
		// comment). So an extra add never suppresses an otherwise-valid flag in v1.
		const bundle = makeBundle(["pr-A", "pr-B", "pr-C", "pr-D"]);
		const touchesByPr = new Map([
			["pr-A", [touch("add")]],
			["pr-B", [touch("remove")]],
			["pr-C", [touch("reference")]],
			["pr-D", [touch("add")]],
		]);

		const signals = findSymbolInconsistencies(bundle, touchesByPr);
		const prIds = new Set(signals.map((s) => s.prId));
		expect(prIds).toEqual(new Set(["pr-B", "pr-C"]));
	});

	it("does not flag a single-PR face (one PR both removes and references the same name)", () => {
		const bundle = makeBundle(["pr-A"]);
		const touchesByPr = new Map([
			["pr-A", [touch("remove"), touch("reference")]],
		]);

		expect(findSymbolInconsistencies(bundle, touchesByPr)).toEqual([]);
	});
});
