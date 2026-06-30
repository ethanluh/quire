import type { Diff } from "../../types/core.js";
import type { LlmProvider } from "./provider.js";

const SYSTEM_PROMPT = `You are a code analyst. You will be given a code diff.
List every distinct product-level effect this diff has, as short independent clauses.
Do not speculate about intent. Derive effects only from what the code does.
Output only a JSON array of strings, one string per effect clause.
Example: ["adds rate limiting to login endpoint", "logs failed auth attempts"]`;

export async function extractEffects(
	diff: Diff,
	testNamesChanged: ReadonlyArray<string>,
	provider: LlmProvider,
): Promise<ReadonlyArray<string>> {
	const testContext =
		testNamesChanged.length > 0
			? `\n\nTest assertions added or changed:\n${testNamesChanged.map((t) => `- ${t}`).join("\n")}`
			: "";

	const userContent = `Diff:\n\`\`\`\n${diff.raw}\n\`\`\`${testContext}`;

	const response = await provider.complete([
		{ role: "system", content: SYSTEM_PROMPT },
		{ role: "user", content: userContent },
	]);

	try {
		const parsed: unknown = JSON.parse(response);
		if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
			return parsed as string[];
		}
	} catch {
		// fall through
	}

	// Fallback: split on newlines and strip list markers
	return response
		.split("\n")
		.map((l) => l.replace(/^[-*\d.)\s]+/, "").trim())
		.filter((l) => l.length > 0);
}
