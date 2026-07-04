import type { MergeRegion } from "node-diff3";
import type { LlmMessage, LlmProvider } from "../drift/effectList/provider.js";
import { stripCodeFence } from "../drift/effectList/stripCodeFence.js";
import { checkSyntax } from "./checkSyntax.js";
import { errorMessage } from "../util/error.js";
import type { ConflictHunk } from "./conflictHunks.js";
import { reconstructContent } from "./conflictHunks.js";

export type HunkConfidence = "high" | "low";

export interface SemanticHunkResolution {
	resolution: string;
	confidence: HunkConfidence;
	// Only set on a fail-closed fallback (INV-6: disclose what the system could not clear) —
	// carries the most recent attempt's problem(s) through to the human-facing card
	// (conflictResolution.ts's describeLowConfidenceHunk) instead of leaving a bare "low"
	// confidence with no explanation of what specifically went wrong.
	reason?: string;
}

// Lets resolveSemanticHunks gate its own output against the whole file, not just the
// fragments it was given — a hunk's resolved text can be syntactically fine in isolation
// and still break the file once combined with its neighbors (e.g. a dangling brace one
// hunk closes and another was supposed to open). Optional: callers with no file-level
// context (e.g. tests exercising hunks in isolation) can omit it and skip the gate.
export interface SemanticHunkSyntaxContext {
	path: string;
	regions: ReadonlyArray<MergeRegion<string>>;
	mechanicalResolutions: ReadonlyMap<number, string>;
}

const MAX_HUNK_RESOLUTION_ATTEMPTS = 3;

const SYSTEM_PROMPT = `You are resolving merge conflicts. You will be given a numbered list of conflicting hunks, each with the common-ancestor version (base), the incoming PR's version (ours), and the target branch's version (theirs), plus the PR's declared direction as a tiebreaker.
For each hunk, output the resolved text and a confidence level:
- "high": you are confident the resolution preserves both sides' intent (or correctly favors one) without risking incorrect behavior.
- "low": the two sides are genuinely incompatible, or resolving confidently would require product/business judgment you don't have — do not guess.
Output only a JSON array, one entry per hunk, in the same order as given: [{"hunk_id": number, "resolution": string, "confidence": "high" | "low"}]`;

// Line-anchored, not a substring match — a legitimate source file can contain `=======` as
// a comment divider; only a full conflict-marker line counts.
const CONFLICT_MARKER_LINE = /^<{7}(?: .*)?$|^={7}$|^>{7}(?: .*)?$/m;

function renderHunk(hunk: ConflictHunk, hunkId: number): string {
	return [
		`Hunk ${hunkId}:`,
		`Base:\n${hunk.baseLines.join("\n")}`,
		`Ours (incoming PR):\n${hunk.oursLines.join("\n")}`,
		`Theirs (target branch):\n${hunk.theirsLines.join("\n")}`,
	].join("\n\n");
}

function buildUserContent(hunks: ReadonlyArray<ConflictHunk>, declaredDirection: string): string {
	return `PR's declared direction: "${declaredDirection}"\n\n${hunks.map((hunk, i) => renderHunk(hunk, i + 1)).join("\n\n---\n\n")}`;
}

function retryFeedback(problem: string): LlmMessage {
	return {
		role: "user",
		content: `${problem}. Revise your answer: output ONLY the corrected JSON array, in the same format as before, with no explanation.`,
	};
}

interface ParsedAttempt {
	byHunkId: Map<number, SemanticHunkResolution>;
	parseError?: string;
}

function parseAttempt(response: string): ParsedAttempt {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripCodeFence(response));
	} catch (err) {
		return { byHunkId: new Map(), parseError: `your response was not valid JSON: ${errorMessage(err)}` };
	}
	if (!Array.isArray(parsed)) {
		return { byHunkId: new Map(), parseError: "your response must be a JSON array of hunk resolutions, not an object or other value" };
	}

	const byHunkId = new Map<number, SemanticHunkResolution>();
	for (const item of parsed) {
		if (
			typeof item === "object" &&
			item !== null &&
			"hunk_id" in item &&
			"resolution" in item &&
			"confidence" in item &&
			typeof (item as Record<string, unknown>)["hunk_id"] === "number" &&
			typeof (item as Record<string, unknown>)["resolution"] === "string" &&
			((item as Record<string, unknown>)["confidence"] === "high" || (item as Record<string, unknown>)["confidence"] === "low")
		) {
			byHunkId.set((item as Record<string, unknown>)["hunk_id"] as number, {
				resolution: (item as Record<string, unknown>)["resolution"] as string,
				confidence: (item as Record<string, unknown>)["confidence"] as HunkConfidence,
			});
		}
	}
	return { byHunkId };
}

// A hunk missing from every attempt's response, or one this file's syntax gate never
// cleared, fails closed to low confidence rather than treating "absent"/"unparseable" as
// resolved. `issues` is the most recent attempt's problem list, carried into `reason` so
// the human-facing card can disclose it (INV-6) instead of a bare "low confidence".
function fallbackResolution(hunk: ConflictHunk, issues: ReadonlyArray<string>): SemanticHunkResolution {
	return {
		resolution: hunk.oursLines.join("\n"),
		confidence: "low",
		...(issues.length > 0 ? { reason: issues.join("; ") } : {}),
	};
}

// One batched call for every semantic hunk across the whole PR, not one call per hunk —
// this is the main cost lever: mechanical hunks (conflictHunks.ts) already cost zero model
// calls, and this keeps the remainder to a single round trip regardless of hunk count.
//
// A bad response (unparseable JSON, a hunk missing from the reply, leftover conflict-marker
// text, or — when syntaxContext is given — a combined file that fails to parse) doesn't sink
// the whole batch on the first try: it's fed back to the model as specific, actionable
// feedback for a bounded number of retries. Hunks a given attempt DID resolve validly are
// kept across retries rather than re-requested, so a retry only has to fix what was
// actually wrong. A transport-level failure (the call itself throwing) gets the same bounded
// retry but no conversational feedback — there's nothing for the model to react to — it's
// just tried again as-is, same as a plain network retry would be.
export async function resolveSemanticHunks(
	hunks: ReadonlyArray<ConflictHunk>,
	declaredDirection: string,
	provider: LlmProvider,
	syntaxContext?: SemanticHunkSyntaxContext,
): Promise<ReadonlyArray<SemanticHunkResolution>> {
	if (hunks.length === 0) return [];

	const messages: LlmMessage[] = [
		{ role: "system", content: SYSTEM_PROMPT },
		{ role: "user", content: buildUserContent(hunks, declaredDirection) },
	];
	const resolved = new Map<number, SemanticHunkResolution>();
	let lastIssues: ReadonlyArray<string> = [];

	for (let attempt = 1; attempt <= MAX_HUNK_RESOLUTION_ATTEMPTS; attempt++) {
		const isLastAttempt = attempt === MAX_HUNK_RESOLUTION_ATTEMPTS;

		let response: string;
		try {
			response = await provider.complete(messages);
		} catch (err) {
			lastIssues = [`the model call failed: ${errorMessage(err)}`];
			if (isLastAttempt) break;
			continue;
		}

		const { byHunkId, parseError } = parseAttempt(response);
		const issues: string[] = parseError !== undefined ? [parseError] : [];
		for (const [hunkId, resolution] of byHunkId) {
			if (hunkId < 1 || hunkId > hunks.length || resolved.has(hunkId)) continue;
			if (CONFLICT_MARKER_LINE.test(resolution.resolution)) {
				issues.push(`hunk_id ${hunkId}'s resolution still contains git conflict marker lines (<<<<<<<, =======, >>>>>>>)`);
				continue;
			}
			resolved.set(hunkId, resolution);
		}
		const missingIds = hunks.map((_, i) => i + 1).filter((id) => !resolved.has(id));
		if (missingIds.length > 0) {
			issues.push(`missing a resolution for hunk_id${missingIds.length > 1 ? "s" : ""} ${missingIds.join(", ")} — every hunk needs one`);
		}

		if (issues.length === 0 && syntaxContext !== undefined) {
			const candidate = new Map<number, string>(syntaxContext.mechanicalResolutions);
			hunks.forEach((hunk, i) => candidate.set(hunk.index, (resolved.get(i + 1) as SemanticHunkResolution).resolution));
			const syntaxError = checkSyntax(syntaxContext.path, reconstructContent(syntaxContext.regions, candidate));
			if (syntaxError !== undefined) {
				issues.push(`combining these resolutions with the rest of ${syntaxContext.path} does not parse as valid code: ${syntaxError}`);
				// The break could have come from any hunk once combined with its neighbors —
				// clear everything so the next attempt revises the whole batch instead of
				// assuming hunks that looked fine in isolation are still safe.
				resolved.clear();
			}
		}

		if (issues.length === 0) {
			return hunks.map((hunk, i) => resolved.get(i + 1) as SemanticHunkResolution);
		}
		lastIssues = issues;
		if (isLastAttempt) break;
		messages.push({ role: "assistant", content: response }, retryFeedback(issues.join("; ")));
	}

	return hunks.map((hunk, i) => resolved.get(i + 1) ?? fallbackResolution(hunk, lastIssues));
}
