import type { LlmProvider } from "../drift/effectList/provider.js";
import { stripCodeFence } from "../drift/effectList/stripCodeFence.js";
import type { ConflictHunk } from "./conflictHunks.js";

export type HunkConfidence = "high" | "low";

export interface SemanticHunkResolution {
	resolution: string;
	confidence: HunkConfidence;
}

const SYSTEM_PROMPT = `You are resolving merge conflicts. You will be given a numbered list of conflicting hunks, each with the common-ancestor version (base), the incoming PR's version (ours), and the target branch's version (theirs), plus the PR's declared direction as a tiebreaker.
For each hunk, output the resolved text and a confidence level:
- "high": you are confident the resolution preserves both sides' intent (or correctly favors one) without risking incorrect behavior.
- "low": the two sides are genuinely incompatible, or resolving confidently would require product/business judgment you don't have — do not guess.
Output only a JSON array, one entry per hunk, in the same order as given: [{"hunk_id": number, "resolution": string, "confidence": "high" | "low"}]`;

function renderHunk(hunk: ConflictHunk, hunkId: number): string {
	return [
		`Hunk ${hunkId}:`,
		`Base:\n${hunk.baseLines.join("\n")}`,
		`Ours (incoming PR):\n${hunk.oursLines.join("\n")}`,
		`Theirs (target branch):\n${hunk.theirsLines.join("\n")}`,
	].join("\n\n");
}

// Fail closed to low confidence rather than throwing or silently treating an
// unparseable/malformed response as resolved — matches the "confidence: low → human
// review" failure mode from the design this pipeline is based on.
function allLowConfidence(hunks: ReadonlyArray<ConflictHunk>): SemanticHunkResolution[] {
	return hunks.map((hunk) => ({ resolution: hunk.oursLines.join("\n"), confidence: "low" }));
}

// One batched call for every semantic hunk across the whole PR, not one call per hunk —
// this is the main cost lever: mechanical hunks (conflictHunks.ts) already cost zero model
// calls, and this keeps the remainder to a single round trip regardless of hunk count.
export async function resolveSemanticHunks(
	hunks: ReadonlyArray<ConflictHunk>,
	declaredDirection: string,
	provider: LlmProvider,
): Promise<ReadonlyArray<SemanticHunkResolution>> {
	if (hunks.length === 0) return [];

	const userContent = `PR's declared direction: "${declaredDirection}"\n\n${hunks
		.map((hunk, i) => renderHunk(hunk, i + 1))
		.join("\n\n---\n\n")}`;

	const response = await provider.complete([
		{ role: "system", content: SYSTEM_PROMPT },
		{ role: "user", content: userContent },
	]);

	try {
		const parsed: unknown = JSON.parse(stripCodeFence(response));
		if (!Array.isArray(parsed)) return allLowConfidence(hunks);

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
				((item as Record<string, unknown>)["confidence"] === "high" ||
					(item as Record<string, unknown>)["confidence"] === "low")
			) {
				byHunkId.set((item as Record<string, unknown>)["hunk_id"] as number, {
					resolution: (item as Record<string, unknown>)["resolution"] as string,
					confidence: (item as Record<string, unknown>)["confidence"] as HunkConfidence,
				});
			}
		}

		// A hunk missing from the response never got an independent judgment — fail that
		// hunk closed to low confidence rather than treating "absent" as "resolved".
		return hunks.map(
			(hunk, i) => byHunkId.get(i + 1) ?? { resolution: hunk.oursLines.join("\n"), confidence: "low" },
		);
	} catch {
		return allLowConfidence(hunks);
	}
}
