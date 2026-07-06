import { UNDECLARED_DIRECTION, type PullRequest } from "../types/core.js";
import type { LlmMessage, LlmProvider } from "../drift/effectList/provider.js";
import { stripCodeFence } from "../drift/effectList/stripCodeFence.js";

export interface LinkedIssue {
	number: number;
	title: string;
	body: string | null;
}

export type SpecConformanceResult =
	| { outcome: "clean" }
	| { outcome: "flagged"; explanation: string }
	// No linked issue, no declared direction, a failed fetch, or an unparseable model
	// response after retries — we have no evidence either way, so this is disclosed
	// (see review/card.ts's specConformanceDisclosure) rather than silently passed as
	// "clean" or fabricated as a "flagged" mismatch (INV-6).
	| { outcome: "inconclusive" };

const MAX_ATTEMPTS = 2;

const SYSTEM_PROMPT = `You compare an AI coding agent's declared implementation direction for a pull request against the GitHub issue it claims to close.
Flag ONLY if the declared direction represents a materially different task than the issue asked for — the agent quietly redefined what it was building.
Do NOT flag: scope-narrowing (doing less of the same task), phrasing differences, or reasonable implementation choices the issue left open.
Output only JSON: {"conforms": boolean, "explanation": string | null}. Set "explanation" only when "conforms" is false, and keep it to one sentence.`;

function buildUserContent(pr: PullRequest, issue: LinkedIssue): string {
	return `Issue #${issue.number} — "${issue.title}"\n${issue.body ?? "(no description)"}\n\n---\n\nPR's declared direction: "${pr.declaredDirection}"`;
}

function retryFeedback(problem: string): LlmMessage {
	return {
		role: "user",
		content: `${problem}. Revise your answer: output ONLY the corrected JSON object, in the same format as before, with no explanation.`,
	};
}

interface ParsedResponse {
	conforms: boolean;
	explanation: string | null;
}

function parseResponse(response: string): ParsedResponse | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripCodeFence(response));
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const v = parsed as Record<string, unknown>;
	if (typeof v["conforms"] !== "boolean") return undefined;
	const explanation = v["explanation"];
	if (explanation !== undefined && explanation !== null && typeof explanation !== "string") return undefined;
	return { conforms: v["conforms"], explanation: explanation ?? null };
}

// A single provider.complete() call per PR — no batching needed (unlike
// resolveSemanticHunks, which batches many hunks into one call): there is exactly one
// judgment to make per PR, so a single call is already the cheapest possible shape.
export async function checkSpecConformance(
	pr: PullRequest,
	issue: LinkedIssue | undefined,
	provider: LlmProvider,
): Promise<SpecConformanceResult> {
	if (pr.declaredDirection === UNDECLARED_DIRECTION || issue === undefined) {
		return { outcome: "inconclusive" };
	}

	const messages: LlmMessage[] = [
		{ role: "system", content: SYSTEM_PROMPT },
		{ role: "user", content: buildUserContent(pr, issue) },
	];

	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		const isLastAttempt = attempt === MAX_ATTEMPTS;

		let response: string;
		try {
			response = await provider.complete(messages);
		} catch {
			if (isLastAttempt) return { outcome: "inconclusive" };
			continue;
		}

		const parsed = parseResponse(response);
		if (parsed === undefined) {
			if (isLastAttempt) return { outcome: "inconclusive" };
			messages.push(
				{ role: "assistant", content: response },
				retryFeedback('your response was not a valid JSON object of the form {"conforms": boolean, "explanation": string | null}'),
			);
			continue;
		}

		if (parsed.conforms) return { outcome: "clean" };
		return { outcome: "flagged", explanation: parsed.explanation ?? "declared direction no longer matches the linked issue" };
	}

	return { outcome: "inconclusive" };
}
