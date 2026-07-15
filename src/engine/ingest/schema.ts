import { z } from "zod";

// Upper bounds are deliberately generous — a real PR never approaches them — but they turn an
// unbounded field into a bounded one so a malformed/hostile ingest payload can't force an
// arbitrarily large synchronous parse/scan (normalizePR splits diff.raw on every newline).
const MAX_DIFF_RAW = 5_000_000; // ~5 MB of unified diff text
const MAX_HUNKS = 10_000;
const MAX_HUNK_LINES = 100_000;
const MAX_LINE = 100_000;
const MAX_FILES = 10_000;
const MAX_SYMBOLS = 50_000;
const MAX_STR = 10_000;

export const DiffHunkSchema = z.object({
	filePath: z.string().max(MAX_STR),
	additions: z.array(z.string().max(MAX_LINE)).max(MAX_HUNK_LINES),
	deletions: z.array(z.string().max(MAX_LINE)).max(MAX_HUNK_LINES),
});

export const DiffSchema = z.object({
	raw: z.string().max(MAX_DIFF_RAW),
	hunks: z.array(DiffHunkSchema).max(MAX_HUNKS),
});

export const IncomingPRSchema = z.object({
	id: z.string().max(MAX_STR),
	repoOwner: z.string().max(MAX_STR),
	repoName: z.string().max(MAX_STR),
	number: z.number().int().positive(),
	headSha: z.string().max(MAX_STR),
	declaredDirection: z.string().min(1).max(MAX_STR),
	directionInferred: z.boolean().optional().default(false),
	linkedIssueNumber: z.number().int().positive().optional(),
	diff: DiffSchema,
	filesTouched: z.array(z.string().max(MAX_STR)).max(MAX_FILES).optional(),
	labels: z.array(z.string().max(MAX_STR)).max(MAX_FILES).optional(),
	assignees: z.array(z.string().max(MAX_STR)).max(MAX_FILES).optional(),
	symbolsTouched: z.array(z.object({
		name: z.string().max(MAX_STR),
		filePath: z.string().max(MAX_STR),
		kind: z.enum(["function", "class", "variable", "type", "export"]),
	})).max(MAX_SYMBOLS).optional(),
	ciStatus: z.enum(["success", "failure", "pending", "unknown"]).default("unknown"),
	ciChecksSummary: z.object({
		completed: z.number().int().nonnegative(),
		total: z.number().int().nonnegative(),
	}).optional(),
});

export type IncomingPR = z.infer<typeof IncomingPRSchema>;
