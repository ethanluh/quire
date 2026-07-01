const CODE_FENCE = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/;

// LLMs routinely wrap JSON output in a markdown code fence even when told
// "output only a JSON array" — strip it so JSON.parse sees bare JSON instead
// of falling through to a fallback parser that was never meant to carry the
// primary path.
export function stripCodeFence(text: string): string {
	const trimmed = text.trim();
	const match = CODE_FENCE.exec(trimmed);
	return match?.[1] !== undefined ? match[1].trim() : trimmed;
}
