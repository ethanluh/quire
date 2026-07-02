import { randomBytes } from "node:crypto";
import { merge as diff3Merge } from "node-diff3";
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

export type ConflictResolutionOutcome =
	| { status: "resolved" }
	| { status: "failed"; reason: string }
	| { status: "dispatched"; prId: string; workflowRunId?: number; callbackToken: string };

// One full attempt: fetch the three trees, triage every touched path, resolve whatever
// diff3 can on its own, commit if everything resolved that way. The moment a file survives
// diff3 with real conflict markers, stop and dispatch the whole PR to the target repo's
// conflict-resolution Action instead — that Action re-merges the branch itself in its own
// checkout, so a partial Quire-side commit of the cheaply-resolved files would just be redone.
// Never loops or retries internally — the caller (mergeQueue.ts) decides what happens next.
export async function resolveMergeConflict(
	bundleId: string,
	pr: PullRequest,
	mergeability: MergeabilityResult,
	github: GitHubClient,
	callbackBaseUrl: string | undefined,
): Promise<ConflictResolutionOutcome> {
	if (mergeability.isFork) {
		return { status: "failed", reason: "head branch lives in a fork this installation can't push to" };
	}

	const trees = await github.getConflictTrees(pr.repoOwner, pr.repoName, pr.number);
	const plans = planFileResolutions(trees);
	const resolvedFiles: ResolvedFile[] = [];

	for (const plan of plans) {
		if (plan.kind === "takeOurs") continue; // head already has the right content

		if (plan.kind === "structuralConflict") {
			return { status: "failed", reason: `${plan.path}: ${plan.reason}` };
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
			const merged = diff3Merge(oursContent, mergeBaseContent, theirsContent, {
				stringSeparator: "\n",
				label: { a: "PR (ours)", b: "main (theirs)" },
			});
			const mergedContent = merged.result.join("\n");
			if (!merged.conflict) {
				resolvedFiles.push({ path: plan.path, content: mergedContent, mode: plan.mode });
				continue;
			}

			// diff3 itself couldn't resolve this file — hand the whole PR off to the target
			// repo's Action rather than resolving file-by-file (see function comment).
			if (callbackBaseUrl === undefined) {
				return {
					status: "failed",
					reason: "QUIRE_PUBLIC_URL is not configured — the conflict-resolution Action has no way to call back to this instance",
				};
			}
			const callbackToken = randomBytes(32).toString("hex");
			let dispatch;
			try {
				dispatch = await github.dispatchConflictResolution(pr.repoOwner, pr.repoName, {
					prNumber: pr.number,
					headBranch: mergeability.headBranch,
					baseBranch: mergeability.baseBranch,
					declaredDirection: pr.declaredDirection,
					callbackUrl: `${callbackBaseUrl}/${bundleId}/resolution`,
					callbackToken,
				});
			} catch (dispatchErr) {
				// Most commonly: the target repo hasn't merged Quire's setup PR yet, so
				// workflow_dispatch has no workflow file on the default branch to target.
				// Surface it as a plain resolution failure rather than an uncaught exception
				// that would crash dequeueNext() for every other queued bundle too.
				const message = dispatchErr instanceof Error ? dispatchErr.message : String(dispatchErr);
				return {
					status: "failed",
					reason: `could not dispatch the conflict-resolution workflow (merge Quire's setup PR first if you haven't): ${message}`,
				};
			}
			return {
				status: "dispatched",
				prId: pr.id,
				callbackToken,
				...(dispatch.workflowRunId !== undefined ? { workflowRunId: dispatch.workflowRunId } : {}),
			};
		} catch (err) {
			if (err instanceof BinaryFileError) {
				return { status: "failed", reason: `${plan.path}: binary file conflict, cannot auto-resolve` };
			}
			throw err;
		}
	}

	if (resolvedFiles.length === 0) {
		// Nothing actually needed a content change — GitHub's "dirty" read was likely
		// already stale. Let the caller re-poll mergeability and retry the merge itself.
		return { status: "resolved" };
	}

	try {
		await github.commitResolvedFiles(pr.repoOwner, pr.repoName, pr.number, mergeability.baseSha, resolvedFiles);
	} catch (err) {
		if (err instanceof NotFastForwardError) {
			return { status: "failed", reason: "head branch moved during conflict resolution" };
		}
		throw err;
	}

	return { status: "resolved" };
}
