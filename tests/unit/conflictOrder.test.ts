import { describe, it, expect } from "@jest/globals";
import { orderByConflictRisk } from "../../src/engine/bundle/conflictOrder.js";
import type { Bundle, PullRequest } from "../../src/engine/types/core.js";

function makePr(id: string, filesTouched: ReadonlyArray<string>): PullRequest {
	return {
		id,
		repoOwner: "org",
		repoName: "repo",
		number: 1,
		headSha: "sha-1",
		declaredDirection: "add passwordless auth",
		directionInferred: false,
		diff: { raw: "", hunks: [] },
		filesTouched,
		symbolsTouched: [],
		testNamesChanged: [],
		ciStatus: "success",
	};
}

function makeBundle(id: string, filesTouched: ReadonlyArray<string>): Bundle {
	return {
		id,
		direction: "add passwordless auth",
		directionInferred: false,
		effectSummary: "adds OTP-based login",
		members: [makePr(`${id}-pr-1`, filesTouched)],
	};
}

describe("orderByConflictRisk", () => {
	it("keeps input order when no bundles share any files", () => {
		const bundles = [makeBundle("a", ["src/a.ts"]), makeBundle("b", ["src/b.ts"]), makeBundle("c", ["src/c.ts"])];

		expect(orderByConflictRisk(bundles)).toEqual(["a", "b", "c"]);
	});

	it("sorts a bundle overlapping two others after bundles with no overlap", () => {
		const isolated1 = makeBundle("isolated-1", ["src/one.ts"]);
		const isolated2 = makeBundle("isolated-2", ["src/two.ts"]);
		// Shares src/shared.ts with both of two other bundles below.
		const entangled = makeBundle("entangled", ["src/shared.ts"]);
		const rival1 = makeBundle("rival-1", ["src/shared.ts"]);
		const rival2 = makeBundle("rival-2", ["src/shared.ts"]);

		const order = orderByConflictRisk([entangled, isolated1, rival1, isolated2, rival2]);

		expect(order.indexOf("isolated-1")).toBeLessThan(order.indexOf("entangled"));
		expect(order.indexOf("isolated-2")).toBeLessThan(order.indexOf("entangled"));
		expect(order.indexOf("isolated-1")).toBeLessThan(order.indexOf("rival-1"));
	});

	it("tie-breaks equal entanglement by ascending footprint size", () => {
		const small = makeBundle("small", ["src/shared.ts"]);
		const large: Bundle = {
			id: "large",
			direction: "add passwordless auth",
			directionInferred: false,
			effectSummary: "adds OTP-based login",
			members: [makePr("large-pr-1", ["src/shared.ts", "src/extra-1.ts", "src/extra-2.ts"])],
		};
		const rival = makeBundle("rival", ["src/shared.ts"]);

		const order = orderByConflictRisk([large, rival, small]);

		// "large" and "small" both overlap only with "rival" (entanglement = 1 each), so the
		// smaller footprint ("small", 1 file) sorts ahead of the larger one (3 files).
		expect(order.indexOf("small")).toBeLessThan(order.indexOf("large"));
	});
});
