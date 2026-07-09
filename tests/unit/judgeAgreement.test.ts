import { describe, it, expect } from "@jest/globals";
import { computeJudgeAgreement } from "../../src/engine/judge/agreement.js";
import type { JudgeVerdictRecord } from "../../src/engine/types/judge.js";
import type { DecidedPrEntry } from "../../src/engine/types/decided.js";

function makeVerdictRecord(bundleId: string, gesture: "accept" | "defer" | "reject", overrides: Partial<JudgeVerdictRecord> = {}): JudgeVerdictRecord {
	return {
		bundleId,
		inputsHash: `hash-${bundleId}`,
		mode: "shadow",
		computedAt: "2026-01-01T00:00:00.000Z",
		status: "ok",
		verdict: {
			gesture,
			confidence: 0.9,
			criteria: { direction: 0.9, drift: 0.9, blastRadius: 0.9, reversibility: 0.9, precedent: 0.9 },
			riskFlags: [],
			rationale: "x",
			precedentIds: [],
			modelId: "fake:judge-model",
		},
		...overrides,
	};
}

function makeDecided(bundleId: string, action: DecidedPrEntry["action"]): DecidedPrEntry {
	return { prId: `${bundleId}-pr`, action, decidedAt: "2026-01-01T00:00:00.000Z", decidedBy: "alice", bundleId };
}

describe("computeJudgeAgreement", () => {
	it("reports undefined agreementRate when nothing is comparable yet", () => {
		const stats = computeJudgeAgreement([makeVerdictRecord("bundle-1", "accept")], []);
		expect(stats.totalJudged).toBe(1);
		expect(stats.comparable).toBe(0);
		expect(stats.agreementRate).toBeUndefined();
	});

	it("counts an agreement when the human's gesture matches the judge's", () => {
		const stats = computeJudgeAgreement([makeVerdictRecord("bundle-1", "accept")], [makeDecided("bundle-1", "accept")]);
		expect(stats.comparable).toBe(1);
		expect(stats.agreements).toBe(1);
		expect(stats.disagreements).toBe(0);
		expect(stats.agreementRate).toBe(1);
	});

	it("counts a disagreement when the human's gesture differs from the judge's", () => {
		const stats = computeJudgeAgreement([makeVerdictRecord("bundle-1", "accept")], [makeDecided("bundle-1", "reject")]);
		expect(stats.comparable).toBe(1);
		expect(stats.agreements).toBe(0);
		expect(stats.disagreements).toBe(1);
		expect(stats.agreementRate).toBe(0);
	});

	it("excludes abstained verdicts from totalJudged", () => {
		const abstained: JudgeVerdictRecord = {
			bundleId: "bundle-1",
			inputsHash: "hash-1",
			mode: "shadow",
			computedAt: "x",
			status: "abstained",
			abstainReason: "no model",
		};
		const stats = computeJudgeAgreement([abstained], []);
		expect(stats.totalJudged).toBe(0);
	});

	it("computes a mixed agreement rate across several bundles", () => {
		const verdicts = [makeVerdictRecord("a", "accept"), makeVerdictRecord("b", "accept"), makeVerdictRecord("c", "reject")];
		const decided = [makeDecided("a", "accept"), makeDecided("b", "reject"), makeDecided("c", "reject")];
		const stats = computeJudgeAgreement(verdicts, decided);
		expect(stats.comparable).toBe(3);
		expect(stats.agreements).toBe(2);
		expect(stats.agreementRate).toBeCloseTo(2 / 3);
	});

	it("uses only the first decided-PR entry per bundleId (every member shares one action)", () => {
		const decided = [makeDecided("bundle-1", "accept"), { ...makeDecided("bundle-1", "accept"), prId: "bundle-1-pr-2" }];
		const stats = computeJudgeAgreement([makeVerdictRecord("bundle-1", "accept")], decided);
		expect(stats.comparable).toBe(1);
	});
});
