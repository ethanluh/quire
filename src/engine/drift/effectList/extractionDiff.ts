import type { Diff } from "../../types/core.js";

// Ceiling on how much diff text one extraction call may bill. A single lockfile-heavy or
// generated-file PR can carry a multi-MB diff; without a cap it becomes uncapped LLM input
// on every headSha change (the pr-cache only dedupes per commit). ~120k chars ≈ ~30k tokens.
export const MAX_EXTRACTION_DIFF_CHARS = 120_000;

export const DIFF_TRUNCATED_MARKER = "[diff truncated: extraction size limit reached]";

// Lockfiles and generated artifacts: near-zero product-effect signal per byte, and the
// dominant source of pathological diff sizes. Matched against the file path of each
// per-file section of the raw unified diff.
const GENERATED_PATH_RE =
	/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|composer\.lock|Cargo\.lock|Gemfile\.lock|poetry\.lock|go\.sum)$|(^|\/)(dist|build|vendor|node_modules)\/|\.(min\.js|min\.css|map|snap)$/;

// Splits a raw unified diff into per-file sections on the "diff --git" header GitHub's
// diff format always emits, drops lockfile/generated sections, and truncates what's left
// to MAX_EXTRACTION_DIFF_CHARS with an explicit marker — the model is told the diff is
// partial rather than silently shown a clean-looking prefix.
export function buildExtractionDiff(diff: Diff): { text: string; skippedFiles: ReadonlyArray<string>; truncated: boolean } {
	const raw = diff.raw;
	const sections = raw.split(/^(?=diff --git )/m);

	const kept: string[] = [];
	const skippedFiles: string[] = [];
	for (const section of sections) {
		const header = /^diff --git a\/(\S+) b\/(\S+)/.exec(section);
		const path = header?.[2] ?? header?.[1];
		if (path !== undefined && GENERATED_PATH_RE.test(path)) {
			skippedFiles.push(path);
			continue;
		}
		kept.push(section);
	}

	let text = kept.join("");
	let truncated = false;
	if (text.length > MAX_EXTRACTION_DIFF_CHARS) {
		text = `${text.slice(0, MAX_EXTRACTION_DIFF_CHARS)}\n${DIFF_TRUNCATED_MARKER}`;
		truncated = true;
	}
	if (skippedFiles.length > 0) {
		text = `${text}\n[${skippedFiles.length} lockfile/generated file(s) omitted: ${skippedFiles.join(", ")}]`;
	}
	return { text, skippedFiles, truncated };
}
