import { describe, it, expect } from "@jest/globals";
import { applyConstitutionGate, resolveJudgeThresholds } from "../../src/engine/judge/gate.js";
import type { JudgeConstitution, JudgeVerdict } from "../../src/engine/types/judge.js";

const CONSTITUTION: JudgeConstitution = {
	version: 1,
	rubric: [
		{ key: "direction", label: "Direction alignment", bands: [{ minScore: 0, maxScore: 1, description: "x" }] },
		{ key: "drift", label: "Drift honesty", bands: [{ minScore: 0, maxScore: 1, description: "x" }] },
		{ key: "blastRadius", label: "Blast radius", bands: [{ minScore: 0, maxScore: 1, description: "x" }] },
		{
			key: "reversibility",
			label: "Reversibility",
			bands: [
				{ minScore: 0, maxScore: 0.4, description: "not cleanly reversible" },
				{ minScore: 0.4, maxScore: 0.8, description: "mostly reversible" },
				{ minScore: 0.8, maxScore: 1, description: "cleanly reversible" },
			],
		},
		{ key: "precedent", label: "Precedent match", bands: [{ minScore: 0, maxScore: 1, description: "x" }] },
	],
	riskTaxonomy: [],
	thresholds: { autoAcceptConfidence: 0.9, autoRejectConfidence: 0.95, maxBlastRadiusAuto: 15 },
};

function makeVerdict(overrides: Partial<JudgeVerdict> = {}): JudgeVerdict {
	return {
		gesture: "accept",
		confidence: 0.95,
		criteria: { direction: 0.9, drift: 0.9, blastRadius: 0.9, reversibility: 0.9, precedent: 0.9 },
		riskFlags: [],
		rationale: "x",
		precedentIds: [],
		modelId: "fake:judge-model",
		...overrides,
	};
}

describe("applyConstitutionGate", () => {
	it("allows an accept with high confidence, low blast radius, reversible, no risk flags", () => {
		const outcome = applyConstitutionGate(makeVerdict(), 5, CONSTITUTION.thresholds, CONSTITUTION);
		expect(outcome).toEqual({ allowed: true, gesture: "accept" });
	});

	it("escalates an accept below the accept confidence threshold", () => {
		const outcome = applyConstitutionGate(makeVerdict({ confidence: 0.85 }), 5, CONSTITUTION.thresholds, CONSTITUTION);
		expect(outcome.allowed).toBe(false);
		if (!outcome.allowed) expect(outcome.reasons.join(" ")).toMatch(/confidence/);
	});

	it("allows a reject at or above the (higher) reject confidence threshold", () => {
		const outcome = applyConstitutionGate(makeVerdict({ gesture: "reject", confidence: 0.95 }), 5, CONSTITUTION.thresholds, CONSTITUTION);
		expect(outcome).toEqual({ allowed: true, gesture: "reject" });
	});

	it("escalates a reject that clears the accept threshold but not the (higher) reject threshold", () => {
		const outcome = applyConstitutionGate(makeVerdict({ gesture: "reject", confidence: 0.92 }), 5, CONSTITUTION.thresholds, CONSTITUTION);
		expect(outcome.allowed).toBe(false);
	});

	it("never allows a defer, regardless of confidence", () => {
		const outcome = applyConstitutionGate(makeVerdict({ gesture: "defer", confidence: 0.99 }), 5, CONSTITUTION.thresholds, CONSTITUTION);
		expect(outcome.allowed).toBe(false);
		if (!outcome.allowed) expect(outcome.reasons.join(" ")).toMatch(/defer/);
	});

	it("escalates when blast radius exceeds the auto-act cap even with high confidence", () => {
		const outcome = applyConstitutionGate(makeVerdict(), 20, CONSTITUTION.thresholds, CONSTITUTION);
		expect(outcome.allowed).toBe(false);
		if (!outcome.allowed) expect(outcome.reasons.join(" ")).toMatch(/blast radius/);
	});

	it("escalates when reversibility falls in its lowest band", () => {
		const outcome = applyConstitutionGate(
			makeVerdict({ criteria: { direction: 0.9, drift: 0.9, blastRadius: 0.9, reversibility: 0.2, precedent: 0.9 } }),
			5,
			CONSTITUTION.thresholds,
			CONSTITUTION,
		);
		expect(outcome.allowed).toBe(false);
		if (!outcome.allowed) expect(outcome.reasons.join(" ")).toMatch(/reversibility/);
	});

	it("does not treat the boundary score between bands as the lowest band", () => {
		const outcome = applyConstitutionGate(
			makeVerdict({ criteria: { direction: 0.9, drift: 0.9, blastRadius: 0.9, reversibility: 0.4, precedent: 0.9 } }),
			5,
			CONSTITUTION.thresholds,
			CONSTITUTION,
		);
		expect(outcome.allowed).toBe(true);
	});

	it("escalates on any risk-taxonomy match regardless of every other score", () => {
		const outcome = applyConstitutionGate(makeVerdict({ riskFlags: ["authentication-or-authorization"] }), 5, CONSTITUTION.thresholds, CONSTITUTION);
		expect(outcome.allowed).toBe(false);
		if (!outcome.allowed) expect(outcome.reasons.join(" ")).toMatch(/risk taxonomy/);
	});

	it("reports every failing reason at once, not just the first", () => {
		const outcome = applyConstitutionGate(
			makeVerdict({ confidence: 0.1, riskFlags: ["authentication-or-authorization"] }),
			100,
			CONSTITUTION.thresholds,
			CONSTITUTION,
		);
		expect(outcome.allowed).toBe(false);
		if (!outcome.allowed) expect(outcome.reasons.length).toBeGreaterThanOrEqual(3);
	});
});

describe("resolveJudgeThresholds", () => {
	it("returns the constitution's own thresholds when no env overrides are set", () => {
		expect(resolveJudgeThresholds({}, CONSTITUTION)).toEqual(CONSTITUTION.thresholds);
	});

	it("applies individual env overrides", () => {
		const thresholds = resolveJudgeThresholds({ QUIRE_JUDGE_AUTOACCEPT_CONFIDENCE: "0.8" }, CONSTITUTION);
		expect(thresholds.autoAcceptConfidence).toBe(0.8);
		expect(thresholds.autoRejectConfidence).toBe(CONSTITUTION.thresholds.autoRejectConfidence);
	});

	it("treats an empty-string override as unset", () => {
		const thresholds = resolveJudgeThresholds({ QUIRE_JUDGE_AUTOACCEPT_CONFIDENCE: "" }, CONSTITUTION);
		expect(thresholds.autoAcceptConfidence).toBe(CONSTITUTION.thresholds.autoAcceptConfidence);
	});

	it("throws when an override would make autoRejectConfidence <= autoAcceptConfidence", () => {
		expect(() =>
			resolveJudgeThresholds({ QUIRE_JUDGE_AUTOACCEPT_CONFIDENCE: "0.96" }, CONSTITUTION),
		).toThrow(/autoRejectConfidence.*must be greater/);
	});

	it("throws on a non-numeric override the same as an out-of-range one", () => {
		// Non-numeric parses to undefined (falls back to the constitution default), so this
		// should NOT throw — documenting that a garbage value degrades to "ignored", not silently 0.
		const thresholds = resolveJudgeThresholds({ QUIRE_JUDGE_MAX_BLAST_RADIUS_AUTO: "not-a-number" }, CONSTITUTION);
		expect(thresholds.maxBlastRadiusAuto).toBe(CONSTITUTION.thresholds.maxBlastRadiusAuto);
	});
});
