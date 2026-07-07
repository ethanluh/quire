import { z } from "zod";

export const DiffHunkSchema = z.object({
	filePath: z.string(),
	additions: z.array(z.string()),
	deletions: z.array(z.string()),
});

export const DiffSchema = z.object({
	raw: z.string(),
	hunks: z.array(DiffHunkSchema),
});

export const IncomingPRSchema = z.object({
	id: z.string(),
	repoOwner: z.string(),
	repoName: z.string(),
	number: z.number().int().positive(),
	headSha: z.string(),
	declaredDirection: z.string().min(1),
	directionInferred: z.boolean().optional().default(false),
	linkedIssueNumber: z.number().int().positive().optional(),
	diff: DiffSchema,
	filesTouched: z.array(z.string()).optional(),
	symbolsTouched: z.array(z.object({
		name: z.string(),
		filePath: z.string(),
		kind: z.enum(["function", "class", "variable", "type", "export"]),
	})).optional(),
	ciStatus: z.enum(["success", "failure", "pending", "unknown"]).default("unknown"),
});

export type IncomingPR = z.infer<typeof IncomingPRSchema>;
