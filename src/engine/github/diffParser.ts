import type { IncomingPR } from "../ingest/schema.js";

type IncomingDiffHunk = IncomingPR["diff"]["hunks"][number];

const FILE_SECTION_RE = /^diff --git /;
const OLD_FILE_RE = /^--- (?:a\/(.+)|\/dev\/null)$/;
const NEW_FILE_RE = /^\+\+\+ (?:b\/(.+)|\/dev\/null)$/;
const HUNK_HEADER_RE = /^@@ /;

// GitHub's diff media type returns a raw unified-diff string (see OctokitGitHubClient).
// The footprint analyzer works off of `Diff.hunks`, so a swarm PR ingested straight
// from GitHub needs this to reconstruct per-file hunks the same shape /prs/ingest expects.
//
// File paths come from the `--- a/...` / `+++ b/...` lines, not the `diff --git a/X b/Y`
// header — that header concatenates both paths on one line with no delimiter, which is
// ambiguous (and mis-splits) for any real path containing the literal substring " b/".
export function parseUnifiedDiff(raw: string): IncomingDiffHunk[] {
	const hunks: IncomingDiffHunk[] = [];
	let oldFile: string | undefined;
	let newFile: string | undefined;
	let currentHunk: { filePath: string; additions: string[]; deletions: string[] } | undefined;

	const flush = (): void => {
		if (currentHunk !== undefined) {
			hunks.push(currentHunk);
			currentHunk = undefined;
		}
	};

	for (const line of raw.split("\n")) {
		if (FILE_SECTION_RE.test(line)) {
			flush();
			oldFile = undefined;
			newFile = undefined;
			continue;
		}
		const oldMatch = OLD_FILE_RE.exec(line);
		if (oldMatch !== null) {
			oldFile = oldMatch[1];
			continue;
		}
		const newMatch = NEW_FILE_RE.exec(line);
		if (newMatch !== null) {
			newFile = newMatch[1];
			continue;
		}
		if (HUNK_HEADER_RE.test(line)) {
			flush();
			currentHunk = { filePath: newFile ?? oldFile ?? "unknown", additions: [], deletions: [] };
			continue;
		}
		if (currentHunk === undefined) continue;
		if (line.startsWith("+")) currentHunk.additions.push(line);
		else if (line.startsWith("-")) currentHunk.deletions.push(line);
	}
	flush();

	return hunks;
}
