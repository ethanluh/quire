import { z } from "zod";
import type { Bundle, ReviewCard } from "../types/core.js";
import type { JudgeConstitution, JudgeVerdict, PrecedentExample } from "../types/judge.js";
import type { LlmMessage, LlmProvider } from "../drift/effectList/provider.js";
import { StubLlmProvider } from "../drift/effectList/stubProvider.js";
import { stripCodeFence } from "../drift/effectList/stripCodeFence.js";
import { errorMessage } from "../util/error.js";

const MAX_ATTEMPTS = 3;

const GESTURE_PAST_TENSE: Record<"accept" | "reject" | "defer", string> = {
	accept: "accepted",
	reject: "rejected",
	defer: "deferred",
};

const rawVerdictSchema = z.object({
	gesture: z.enum(["accept", "defer", "reject"]),
	confidence: z.number().min(0).max(1),
	criteria: z.object({
		direction: z.number().min(0).max(1),
		drift: z.number().min(0).max(1),
		blastRadius: z.number().min(0).max(1),
		reversibility: z.number().min(0).max(1),
		precedent: z.number().min(0).max(1),
	}),
	riskFlags: z.array(z.string()),
	rationale: z.string().min(1),
	precedentIds: z.array(z.string()),
});

export interface BundleJudgeInputs {
	bundle: Bundle;
	card: ReviewCard;
	constitution: JudgeConstitution;
	precedent: ReadonlyArray<PrecedentExample>;
	// Computed by the caller (riskTaxonomy.ts) before invoking the judge, not re-derived
	// here — bundleJudge.ts has no opinion on file-pattern matching, only on merging the
	// result with whatever the model itself names (see the riskFlags union below).
	deterministicRiskFlags: ReadonlyArray<string>;
}

export type BundleJudgeResult =
	| { status: "ok"; verdict: JudgeVerdict }
	// Fail-closed, mirroring semanticHunkResolver.ts's fallbackResolution: a judge that
	// cannot produce a valid verdict must never be mistaken for one that scored the bundle
	// low. gate.ts (Phase 3) treats an abstention as "no verdict exists," which always
	// escalates — same as a bundle the judge never ran against.
	| { status: "abstained"; reason: string };

function formatBands(criterionLabel: string, criterionKey: string, bands: JudgeConstitution["rubric"][number]["bands"]): string {
	const bandLines = bands.map((b) => `  - ${b.minScore.toFixed(2)}-${b.maxScore.toFixed(2)}: ${b.description}`).join("\n");
	return `${criterionLabel} ("${criterionKey}"):\n${bandLines}`;
}

function buildSystemPrompt(constitution: JudgeConstitution): string {
	const rubricText = constitution.rubric.map((c) => formatBands(c.label, c.key, c.bands)).join("\n\n");
	const taxonomyText = constitution.riskTaxonomy.map((t) => `- ${t.id}: ${t.label} — ${t.description}`).join("\n");

	return [
		"You are the Bundle Judge for Quire, a triage tool that groups swarm-generated pull requests by product direction. You evaluate ONE bundle that has already passed drift detection — its declared direction and its actual effects were independently checked and found consistent — and decide accept, defer, or reject.",
		"You are not a code reviewer. Do not evaluate code quality, style, or correctness — those are out of scope. Evaluate only whether this bundle's direction is one the product should take, given the product-direction principles, precedent, and risk described below.",
		`Score every one of these five rubric criteria from 0.0 to 1.0, using the written guidance for each band:\n\n${rubricText}`,
		`Risk taxonomy — name an entry's id in your own riskFlags whenever the bundle matches it, even one with no file pattern (an external side effect a code revert can't undo):\n${taxonomyText}`,
		'Output ONLY a JSON object with exactly this shape, no prose before or after: {"gesture": "accept" | "defer" | "reject", "confidence": number (0-1), "criteria": {"direction": number, "drift": number, "blastRadius": number, "reversibility": number, "precedent": number}, "riskFlags": string[], "rationale": string, "precedentIds": string[]}',
		"precedentIds must only contain bundle ids actually given to you as precedent below — never invent one.",
	].join("\n\n");
}

function buildUserContent(inputs: BundleJudgeInputs): string {
	const { bundle, card, precedent, deterministicRiskFlags } = inputs;
	const membersText = bundle.members
		.map(
			(m) =>
				`- ${m.repoOwner}/${m.repoName}#${m.number}: declared "${m.declaredDirection}"${
					m.directionInferred ? " (inferred from title/body, not an explicit declaration)" : ""
				}`,
		)
		.join("\n");
	const precedentText =
		precedent.length > 0
			? precedent
					.map(
						(p) =>
							`- [${p.bundleId}] direction: "${p.direction}" — a human ${GESTURE_PAST_TENSE[p.gesture]} this (similarity ${p.similarity.toFixed(2)})`,
					)
					.join("\n")
			: "(no similar past human decision found)";

	return [
		`Bundle direction: "${bundle.direction}"${bundle.directionInferred ? " (inferred, not an explicit declaration)" : ""}`,
		`Bundle's drift-cleared effect summary: "${bundle.effectSummary}"`,
		`Members:\n${membersText}`,
		`Review card: blastRadius=${card.blastRadius} files, flags=[${card.flags.length > 0 ? card.flags.join(", ") : "none"}], drift=clean, specConformance=clean`,
		`Deterministic risk-taxonomy matches already found in the diff: [${
			deterministicRiskFlags.length > 0 ? deterministicRiskFlags.join(", ") : "none"
		}] — include these in your own riskFlags too.`,
		`Nearest past human decisions:\n${precedentText}`,
	].join("\n\n");
}

function retryFeedback(problem: string): LlmMessage {
	return {
		role: "user",
		content: `${problem}. Revise your answer: output ONLY the corrected JSON object, in the same format as before, with no explanation.`,
	};
}

// Never throws. A malformed response, an invented precedent id, or a provider error all fail
// closed to "abstained" after bounded retries — mirrors resolveSemanticHunks's retry-with-
// feedback loop exactly, so the same review of that code applies here.
export async function runBundleJudge(inputs: BundleJudgeInputs, provider: LlmProvider): Promise<BundleJudgeResult> {
	if (provider instanceof StubLlmProvider) {
		return {
			status: "abstained",
			reason: "no real judge LLM configured (stub provider) — the judge cannot run without a connected LLM account",
		};
	}

	const messages: LlmMessage[] = [
		{ role: "system", content: buildSystemPrompt(inputs.constitution) },
		{ role: "user", content: buildUserContent(inputs) },
	];
	const knownPrecedentIds = new Set(inputs.precedent.map((p) => p.bundleId));

	let lastIssue = "no attempt completed";
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		const isLastAttempt = attempt === MAX_ATTEMPTS;

		let response: string;
		try {
			response = await provider.complete(messages);
		} catch (err) {
			lastIssue = `the model call failed: ${errorMessage(err)}`;
			if (isLastAttempt) break;
			continue;
		}

		let parsedJson: unknown;
		try {
			parsedJson = JSON.parse(stripCodeFence(response));
		} catch (err) {
			lastIssue = `your response was not valid JSON: ${errorMessage(err)}`;
			if (isLastAttempt) break;
			messages.push({ role: "assistant", content: response }, retryFeedback(lastIssue));
			continue;
		}

		const result = rawVerdictSchema.safeParse(parsedJson);
		if (!result.success) {
			lastIssue = `your response did not match the required shape: ${result.error.message}`;
			if (isLastAttempt) break;
			messages.push({ role: "assistant", content: response }, retryFeedback(lastIssue));
			continue;
		}

		const invalidPrecedentIds = result.data.precedentIds.filter((id) => !knownPrecedentIds.has(id));
		if (invalidPrecedentIds.length > 0) {
			lastIssue = `precedentIds referenced bundle id(s) not given to you as precedent: ${invalidPrecedentIds.join(", ")}`;
			if (isLastAttempt) break;
			messages.push({ role: "assistant", content: response }, retryFeedback(lastIssue));
			continue;
		}

		const riskFlags = Array.from(new Set([...inputs.deterministicRiskFlags, ...result.data.riskFlags]));
		return {
			status: "ok",
			verdict: {
				gesture: result.data.gesture,
				confidence: result.data.confidence,
				criteria: result.data.criteria,
				riskFlags,
				rationale: result.data.rationale,
				precedentIds: result.data.precedentIds,
				modelId: provider.modelKey,
			},
		};
	}

	return { status: "abstained", reason: `judge produced no valid verdict after ${MAX_ATTEMPTS} attempts: ${lastIssue}` };
}
