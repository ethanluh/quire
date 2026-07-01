// Not anchored to the whole string: real LLM output routinely wraps JSON in a
// fence AND adds surrounding prose ("Here is the result:\n```json\n[...]\n```")
// despite being told "output only a JSON array". Finds the first fenced block
// anywhere in the text, with any (or no) language tag, and extracts only its
// content — so surrounding prose and the tag itself never leak into the result.
const CODE_FENCE = /```(?:\w+)?\s*\n?([\s\S]*?)\n?```/;

export function stripCodeFence(text: string): string {
	const trimmed = text.trim();
	const match = CODE_FENCE.exec(trimmed);
	return match?.[1] !== undefined ? match[1].trim() : trimmed;
}
