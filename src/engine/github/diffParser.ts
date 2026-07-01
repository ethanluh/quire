import type { IncomingPR } from "../ingest/schema.js";

type IncomingDiffHunk = IncomingPR["diff"]["hunks"][number];

const FILE_HEADER_RE = /^diff --git a\/(.+) b\/(.+)$/;
const HUNK_HEADER_RE = /^@@ /;

// GitHub's diff media type returns a raw unified-diff string (see OctokitGitHubClient).
// The footprint analyzer works off of `Diff.hunks`, so a swarm PR ingested straight
// from GitHub needs this to reconstruct per-file hunks the same shape /prs/ingest expects.
export function parseUnifiedDiff(raw: string): IncomingDiffHunk[] {
	const hunks: IncomingDiffHunk[] = [];
	let currentFile: string | undefined;
	let currentHunk: { filePath: string; additions: string[]; deletions: string[] } | undefined;

	const flush = (): void => {
		if (currentHunk !== undefined) {
			hunks.push(currentHunk);
			currentHunk = undefined;
		}
	};

	for (const line of raw.split("\n")) {
		const fileMatch = FILE_HEADER_RE.exec(line);
		if (fileMatch !== null) {
			flush();
			currentFile = fileMatch[2] ?? fileMatch[1];
			continue;
		}
		if (HUNK_HEADER_RE.test(line)) {
			flush();
			currentHunk = { filePath: currentFile ?? "unknown", additions: [], deletions: [] };
			continue;
		}
		if (currentHunk === undefined) continue;
		if (line.startsWith("+")) currentHunk.additions.push(line);
		else if (line.startsWith("-")) currentHunk.deletions.push(line);
	}
	flush();

	return hunks;
}
