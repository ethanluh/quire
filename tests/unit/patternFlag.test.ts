import { describe, it, expect } from "@jest/globals";
import { detectPatternFlag } from "../../src/engine/review/patternFlag.js";
import { StubPatternRegistryClient } from "../mocks/patternRegistry.js";
import type { PatternRegistryClient } from "../../src/engine/drift/patternRegistry/client.js";
import type { Bundle, PullRequest } from "../../src/engine/types/core.js";

function makeBundle(members: PullRequest[] = []): Bundle {
	return {
		id: "bundle-1",
		direction: "add passwordless auth",
		directionInferred: false,
		effectSummary: "adds OTP-based login",
		members,
	};
}

describe("detectPatternFlag", () => {
	it("returns undefined when the registry reports a match", async () => {
		const registry = new StubPatternRegistryClient();
		registry.setResult({ matched: true });
		const flag = await detectPatternFlag(makeBundle(), registry);
		expect(flag).toBeUndefined();
	});

	it("returns a flag string with the reason when the registry reports a mismatch", async () => {
		const registry = new StubPatternRegistryClient();
		registry.setResult({ matched: false, changeClass: "add API endpoint", reason: "hand-rolled auth instead of the shared middleware" });
		const flag = await detectPatternFlag(makeBundle(), registry);
		expect(flag).toBe("unusual implementation pattern: hand-rolled auth instead of the shared middleware");
	});

	it("falls back to changeClass when no reason is given", async () => {
		const registry = new StubPatternRegistryClient();
		registry.setResult({ matched: false, changeClass: "add API endpoint" });
		const flag = await detectPatternFlag(makeBundle(), registry);
		expect(flag).toBe("unusual implementation pattern for add API endpoint");
	});

	it("fails open (no flag) when the registry client throws", async () => {
		const registry: PatternRegistryClient = {
			checkPattern: async () => {
				throw new Error("registry unavailable");
			},
		};
		const flag = await detectPatternFlag(makeBundle(), registry);
		expect(flag).toBeUndefined();
	});
});
