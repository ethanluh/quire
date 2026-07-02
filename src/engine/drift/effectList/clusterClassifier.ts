import type { LlmProvider } from "./provider.js";
import { stripCodeFence } from "./stripCodeFence.js";

const SYSTEM_PROMPT = `You are a code analyst. You will be given a pull request's extracted effects and a
numbered list of summaries, each describing the effects already established for an existing
bundle of other pull requests.
Decide whether the pull request's effects represent the same underlying product change as
exactly one of the summaries.
Respond with only the number of the matching summary, or 0 if none match. Output nothing else.`;

// Returns a 0-based index into centroidTexts naming the matching bundle, or -1 for "no match
// (start a new bundle)". Used only for providers with supportsEmbeddings = false (see
// clusterPRs in similarity.ts) — a single classification call replaces N pairwise
// comparisons against every existing centroid.
export async function classifyBestMatch(
	prEffectText: string,
	centroidTexts: ReadonlyArray<string>,
	provider: Pick<LlmProvider, "complete">,
): Promise<number> {
	// No evidence (nothing extracted for this PR) or nothing to compare against yet —
	// neither case has anything for the model to judge, so don't spend a call on it.
	// INV-1/INV-3: absence of evidence must never become evidence of a match.
	if (prEffectText.trim() === "" || centroidTexts.length === 0) return -1;

	const userContent = `Pull request effects:\n${prEffectText}\n\nExisting bundle summaries:\n${centroidTexts
		.map((text, i) => `${i + 1}. ${text}`)
		.join("\n")}`;

	const response = await provider.complete([
		{ role: "system", content: SYSTEM_PROMPT },
		{ role: "user", content: userContent },
	]);

	// Fail closed: anything that isn't cleanly "the number of a real match" starts a
	// new bundle instead of risking an unverified merge (same posture as matcher.ts's
	// matchEffectsToDirection — a parse failure must never read as agreement).
	const match = /-?\d+/.exec(stripCodeFence(response));
	if (match === null) return -1;
	const oneBased = Number(match[0]);
	if (!Number.isInteger(oneBased) || oneBased < 1 || oneBased > centroidTexts.length) return -1;
	return oneBased - 1;
}
