import type { Effect } from "../../types/core.js";
import type { LlmProvider } from "./provider.js";
import { stripCodeFence } from "./stripCodeFence.js";

const SYSTEM_PROMPT = `You are a code analyst. You will be given a bundle direction and a list of effect clauses extracted from a PR diff.
For each clause, decide whether it matches the stated direction (true) or is an orphan — an effect with no directional home in the bundle's declared intent (false).
Output a JSON array of objects with shape: [{"clause": string, "matchedDirection": boolean}]
Order must match the input clause order exactly.`;

export async function matchEffectsToDirection(
	effects: ReadonlyArray<string>,
	bundleDirection: string,
	provider: LlmProvider,
): Promise<ReadonlyArray<Effect>> {
	if (effects.length === 0) return [];

	const userContent = `Bundle direction: "${bundleDirection}"\n\nEffect clauses:\n${effects.map((e, i) => `${i + 1}. ${e}`).join("\n")}`;

	const response = await provider.complete([
		{ role: "system", content: SYSTEM_PROMPT },
		{ role: "user", content: userContent },
	]);

	try {
		const parsed: unknown = JSON.parse(stripCodeFence(response));
		if (Array.isArray(parsed)) {
			const result: Effect[] = [];
			for (const item of parsed) {
				if (
					typeof item === "object" &&
					item !== null &&
					"clause" in item &&
					"matchedDirection" in item &&
					typeof (item as Record<string, unknown>)["clause"] === "string" &&
					typeof (item as Record<string, unknown>)["matchedDirection"] === "boolean"
				) {
					result.push({
						clause: (item as Record<string, unknown>)["clause"] as string,
						matchedDirection: (item as Record<string, unknown>)["matchedDirection"] as boolean,
					});
				}
			}
			if (result.length === effects.length) return result;
		}
	} catch {
		// fall through
	}

	// Parse failure means the independent check never actually ran. Per INV-3,
	// agreement may never clear a member, so an unverified clause must not be
	// reported as matched — that would be indistinguishable from real agreement
	// and would let a screen failure silently produce a "clean" verdict.
	// Fail closed: treat every clause as an orphan so the screen flags instead.
	return effects.map((clause) => ({ clause, matchedDirection: false }));
}
