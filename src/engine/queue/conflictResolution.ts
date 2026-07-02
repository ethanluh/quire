import { merge as diff3Merge } from "node-diff3";
import type { LlmProvider } from "../drift/effectList/provider.js";
import { stripCodeFence } from "../drift/effectList/stripCodeFence.js";
import type { PullRequest } from "../types/core.js";
import type { ConflictTrees, MergeabilityResult, ResolvedFile } from "../types/mergeability.js";
import { NotFastForwardError } from "../types/mergeability.js";
import type { GitHubClient } from "../github/client.js";
import { BinaryFileError } from "../github/client.js";

export type FileResolutionPlan =
	| { path: string; kind: "takeOurs" }
	| { path: string; kind: "takeTheirs"; sha: string | undefined; mode: string | undefined }
	| { path: string; kind: "needsThreeWayMerge"; mergeBaseSha: string | undefined; oursSha: string; theirsSha: string; mode: string }
	| { path: string; kind: "structuralConflict"; reason: string };

// Triage before running anything expensive: most files in a "dirty" PR weren't touched by
// both sides at all. Comparing blob SHAs across the three trees settles those without a
// single blob fetch, diff3 pass, or LLM call — only genuinely three-way-divergent files
// reach "needsThreeWayMerge".
export function planFileResolutions(trees: ConflictTrees): ReadonlyArray<FileResolutionPlan> {
	const paths = new Set<string>([...trees.mergeBaseTree.keys(), ...trees.baseTree.keys(), ...trees.headTree.keys()]);
	const plans: FileResolutionPlan[] = [];

	for (const path of paths) {
		const base = trees.mergeBaseTree.get(path);
		const ours = trees.headTree.get(path);
		const theirs = trees.baseTree.get(path);

		// Identical on both sides already (including both absent) — nothing to resolve.
		if (ours?.sha === theirs?.sha && ours?.mode === theirs?.mode) continue;

		// Theirs didn't change this path from the common ancestor — ours is already right.
		if (theirs?.sha === base?.sha && theirs?.mode === base?.mode) {
			plans.push({ path, kind: "takeOurs" });
			continue;
		}

		// Ours didn't change this path — adopt theirs' version outright (an accepted
		// incoming change, not a conflict).
		if (ours?.sha === base?.sha && ours?.mode === base?.mode) {
			plans.push({ path, kind: "takeTheirs", sha: theirs?.sha, mode: theirs?.mode });
			continue;
		}

		// Both sides changed this path from the common ancestor (including both adding it
		// where the ancestor had nothing — a genuine add/add case diff3 can still merge
		// against an empty common ancestor). None of the cases below have a line-based
		// merge to attempt.
		if (ours?.type === "commit" || theirs?.type === "commit") {
			plans.push({ path, kind: "structuralConflict", reason: "submodule reference changed on both sides" });
			continue;
		}
		if (ours !== undefined && theirs !== undefined && ours.mode !== theirs.mode) {
			plans.push({ path, kind: "structuralConflict", reason: "file mode changed differently on each side" });
			continue;
		}
		if (ours === undefined || theirs === undefined) {
			// One side deleted the path while the other changed its content — no content
			// exists on the deleting side to three-way-merge against.
			plans.push({ path, kind: "structuralConflict", reason: "modified on one side, deleted on the other" });
			continue;
		}

		plans.push({
			path,
			kind: "needsThreeWayMerge",
			mergeBaseSha: base?.sha,
			oursSha: ours.sha,
			theirsSha: theirs.sha,
			mode: ours.mode,
		});
	}

	return plans;
}

export type FileConflictResolution = { status: "resolved"; content: string } | { status: "unresolved"; reason: string };

// Line-anchored, not a substring match — a legitimate source file can contain `=======` as
// a comment divider; only a full conflict-marker line counts.
const CONFLICT_MARKER_LINE = /^<{7}(?: .*)?$|^={7}$|^>{7}(?: .*)?$/m;

const SYSTEM_PROMPT = `You are resolving a git merge conflict in a single file. You will be given the file's
content with git conflict markers (<<<<<<<, =======, >>>>>>>) showing two divergent
versions, and the product direction the changed-side pull request is pursuing.
Produce the fully resolved file content — the whole file, not just the conflicted
region — that reasonably combines both sides' intent. Preserve everything outside the
conflicted regions exactly as given.
Output ONLY the resolved file in a single fenced code block, with no explanation.
If you cannot confidently resolve this conflict without risking incorrect behavior, output
exactly the single word UNRESOLVED and nothing else.`;

// Runs the pure three-way merge first (node-diff3); only conflicted files reach the LLM.
// Fail-closed throughout, mirroring drift/effectList/matcher.ts's convention: a failed LLM
// call, an explicit "can't resolve," or leftover conflict-marker lines in the model's own
// output are all treated as unresolved — never guessed at or partially applied.
export async function resolveConflictedFile(
	path: string,
	mergeBaseContent: string,
	oursContent: string,
	theirsContent: string,
	prDirection: string,
	provider: LlmProvider,
): Promise<FileConflictResolution> {
	const merged = diff3Merge(oursContent, mergeBaseContent, theirsContent, {
		stringSeparator: "\n",
		label: { a: "PR (ours)", b: "main (theirs)" },
	});
	const mergedContent = merged.result.join("\n");
	if (!merged.conflict) {
		return { status: "resolved", content: mergedContent };
	}

	const userContent = `File: ${path}\nPR direction: "${prDirection}"\n\nConflicted file content:\n\`\`\`\n${mergedContent}\n\`\`\``;

	let response: string;
	try {
		response = await provider.complete([
			{ role: "system", content: SYSTEM_PROMPT },
			{ role: "user", content: userContent },
		]);
	} catch (err) {
		return { status: "unresolved", reason: `LLM call failed: ${err instanceof Error ? err.message : String(err)}` };
	}

	const stripped = stripCodeFence(response).trim();
	if (stripped === "UNRESOLVED") {
		return { status: "unresolved", reason: "model declined to resolve confidently" };
	}
	if (CONFLICT_MARKER_LINE.test(stripped)) {
		return { status: "unresolved", reason: "resolved content still contained conflict markers" };
	}
	return { status: "resolved", content: stripped };
}

export interface ConflictResolutionOutcome {
	resolved: boolean;
	reason?: string;
}

// One full attempt: fetch the three trees, triage every touched path, resolve whatever
// needs it, commit if everything resolved. Never loops or retries internally — the caller
// (mergeQueue.ts) decides whether a failed attempt is worth trying again.
export async function resolveMergeConflict(
	pr: PullRequest,
	mergeability: MergeabilityResult,
	github: GitHubClient,
	provider: LlmProvider,
): Promise<ConflictResolutionOutcome> {
	if (mergeability.isFork) {
		return { resolved: false, reason: "head branch lives in a fork this installation can't push to" };
	}

	const trees = await github.getConflictTrees(pr.repoOwner, pr.repoName, pr.number);
	const plans = planFileResolutions(trees);
	const resolvedFiles: ResolvedFile[] = [];

	for (const plan of plans) {
		if (plan.kind === "takeOurs") continue; // head already has the right content

		if (plan.kind === "structuralConflict") {
			return { resolved: false, reason: `${plan.path}: ${plan.reason}` };
		}

		try {
			if (plan.kind === "takeTheirs") {
				// theirs deleted this path too (undefined sha) — nothing to write; a real
				// modify/delete disagreement was already filtered into structuralConflict.
				if (plan.sha === undefined || plan.mode === undefined) continue;
				const content = await github.getBlobContent(pr.repoOwner, pr.repoName, plan.sha);
				resolvedFiles.push({ path: plan.path, content, mode: plan.mode });
				continue;
			}

			// needsThreeWayMerge
			const [mergeBaseContent, oursContent, theirsContent] = await Promise.all([
				plan.mergeBaseSha !== undefined
					? github.getBlobContent(pr.repoOwner, pr.repoName, plan.mergeBaseSha)
					: Promise.resolve(""),
				github.getBlobContent(pr.repoOwner, pr.repoName, plan.oursSha),
				github.getBlobContent(pr.repoOwner, pr.repoName, plan.theirsSha),
			]);
			const resolution = await resolveConflictedFile(
				plan.path,
				mergeBaseContent,
				oursContent,
				theirsContent,
				pr.declaredDirection,
				provider,
			);
			if (resolution.status === "unresolved") {
				return { resolved: false, reason: `${plan.path}: ${resolution.reason}` };
			}
			resolvedFiles.push({ path: plan.path, content: resolution.content, mode: plan.mode });
		} catch (err) {
			if (err instanceof BinaryFileError) {
				return { resolved: false, reason: `${plan.path}: binary file conflict, cannot auto-resolve` };
			}
			throw err;
		}
	}

	if (resolvedFiles.length === 0) {
		// Nothing actually needed a content change — GitHub's "dirty" read was likely
		// already stale. Let the caller re-poll mergeability and retry the merge itself.
		return { resolved: true };
	}

	try {
		await github.commitResolvedFiles(pr.repoOwner, pr.repoName, pr.number, mergeability.baseSha, resolvedFiles);
	} catch (err) {
		if (err instanceof NotFastForwardError) {
			return { resolved: false, reason: "head branch moved during conflict resolution" };
		}
		throw err;
	}

	return { resolved: true };
}
