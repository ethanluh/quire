import { diff3Merge } from "node-diff3";
import type { MergeRegion } from "node-diff3";

export interface ConflictHunk {
	// Index into the full regions array this hunk came from — used to place a resolution
	// back into the right slot when reconstructing the file (see reconstructContent).
	index: number;
	oursLines: ReadonlyArray<string>;
	baseLines: ReadonlyArray<string>;
	theirsLines: ReadonlyArray<string>;
}

export type HunkClassification = "mechanical" | "semantic";

// Trims only leading/trailing whitespace per line (i.e. reindentation) — deliberately does
// NOT collapse internal whitespace runs, which would misclassify a meaningful whitespace
// change inside a string or regex literal (e.g. "select  *  from users" vs "select * from
// users" — a real behavior change, not formatting) as mechanical.
function normalizeLine(line: string): string {
	return line.trim();
}

// Splits on plain "\n" (not node-diff3's own string-mode splitting) so the resulting line
// arrays can be rejoined with a matching separator in reconstructContent, and callers work
// with plain string[] hunks rather than node-diff3's generic buffer type.
function toLines(text: string): string[] {
	return text.split("\n");
}

// Runs the real three-way merge and returns node-diff3's ordered region list, alternating
// "ok" (already-agreed lines) and "conflict" (genuinely divergent) blocks. This is the same
// diff3Merge() the node-diff3 package exports at the top level — distinct from the `merge()`
// function conflictResolution.ts imports under the same local name; do not confuse the two.
export function extractConflictRegions(ours: string, base: string, theirs: string): ReadonlyArray<MergeRegion<string>> {
	return diff3Merge(toLines(ours), toLines(base), toLines(theirs));
}

// Pulls just the conflicting regions out, in order, as flat hunks — this is the "conflict
// extractor" step: hunk-level, base/ours/theirs per hunk, no marker-text parsing anywhere.
export function extractConflictHunks(regions: ReadonlyArray<MergeRegion<string>>): ReadonlyArray<ConflictHunk> {
	const hunks: ConflictHunk[] = [];
	regions.forEach((region, index) => {
		if (region.conflict === undefined) return;
		hunks.push({
			index,
			oursLines: region.conflict.a,
			baseLines: region.conflict.o,
			theirsLines: region.conflict.b,
		});
	});
	return hunks;
}

// Mechanical: both sides land on the same content once whitespace/formatting differences
// are ignored — nothing for a model to decide. Everything else needs semantic judgment.
// There's no separate static "ambiguous" bucket here: low confidence from the semantic
// resolver is the ambiguous signal, decided at runtime rather than by a hand-tuned
// threshold (see conflictResolution.ts for how a low-confidence hunk fails the file).
export function classifyHunk(hunk: ConflictHunk): HunkClassification {
	if (hunk.oursLines.length !== hunk.theirsLines.length) return "semantic";
	const matches = hunk.oursLines.every((line, i) => normalizeLine(line) === normalizeLine(hunk.theirsLines[i] ?? ""));
	return matches ? "mechanical" : "semantic";
}

// Deterministic resolution for a mechanical hunk: favor `ours` (the incoming PR), matching
// the "takeOurs"/favor-incoming-PR precedent already used for the file-level cases above in
// conflictResolution.ts. Since ours and theirs only differ by whitespace here, either choice
// is substantively equivalent — this just picks one consistently.
export function resolveMechanicalHunk(hunk: ConflictHunk): string {
	return hunk.oursLines.join("\n");
}

// The patch applier: walks the full region list in order, emitting agreed lines verbatim
// and each conflict region's resolved text in its place. `resolutions` maps a hunk's
// `index` (from extractConflictHunks) to its resolved text (which may itself span multiple
// lines) — every conflict region must have an entry or this throws, since a silently
// dropped hunk would produce a file with lines missing rather than a visible failure.
export function reconstructContent(
	regions: ReadonlyArray<MergeRegion<string>>,
	resolutions: ReadonlyMap<number, string>,
): string {
	const lines: string[] = [];
	regions.forEach((region, index) => {
		if (region.conflict !== undefined) {
			const resolution = resolutions.get(index);
			if (resolution === undefined) {
				throw new Error(`No resolution provided for conflict region at index ${index}`);
			}
			lines.push(resolution);
			return;
		}
		if (region.ok !== undefined) {
			lines.push(...region.ok);
		}
	});
	return lines.join("\n");
}
