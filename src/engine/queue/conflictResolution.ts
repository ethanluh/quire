import type { PullRequest } from "../types/core.js";
import type { ConflictTrees, MergeabilityResult, ResolvedFile } from "../types/mergeability.js";
import { NotFastForwardError } from "../types/mergeability.js";
import type { GitHubClient } from "../github/client.js";
import { BinaryFileError } from "../github/client.js";
import type { LlmProvider } from "../drift/effectList/provider.js";
import type { ConflictHunk } from "./conflictHunks.js";
import {
	classifyHunk,
	extractConflictHunks,
	extractConflictRegions,
	reconstructContent,
	resolveMechanicalHunk,
} from "./conflictHunks.js";
import type { SemanticHunkResolution } from "./semanticHunkResolver.js";
import { resolveSemanticHunks } from "./semanticHunkResolver.js";

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

// Hunks are small by construction (a few lines each — see conflictHunks.ts), so the full
// side renders without needing the truncation a whole-file preview would require.
function renderHunkSide(label: string, lines: ReadonlyArray<string>): string {
	return `  ${label}:\n${lines.map((l) => `    ${l}`).join("\n")}`;
}

// Full detail for one low-confidence hunk — per INV-6, a reviewer should be able to act on
// this without re-diffing the file by hand: the actual conflicting content on every side,
// plus what the model tried and how sure it was, rather than a bare "couldn't resolve".
function describeLowConfidenceHunk(hunk: ConflictHunk, resolution: SemanticHunkResolution): string {
	return [
		renderHunkSide("base", hunk.baseLines),
		renderHunkSide("ours", hunk.oursLines),
		renderHunkSide("theirs", hunk.theirsLines),
		`  model's attempted resolution (confidence: ${resolution.confidence}):\n${resolution.resolution
			.split("\n")
			.map((l) => `    ${l}`)
			.join("\n")}`,
	].join("\n");
}

// A hunk-level failure the fast resolver couldn't clear on its own, structured (not just
// rendered to text) so a caller can hand it to a deeper resolution tier — see
// deepConflictInvestigation.ts. Only populated for the "low-confidence semantic hunk" case;
// structural conflicts, binary files, and forks have no hunk content a deeper investigation
// could act on.
export interface ConflictHunkEscalation {
	path: string;
	mode: string;
	oursSha: string;
	theirsSha: string;
	mergeBaseSha: string | undefined;
	lowConfidenceHunks: ReadonlyArray<{ hunk: ConflictHunk; resolution: SemanticHunkResolution }>;
}

export type ConflictResolutionOutcome =
	| { status: "resolved" }
	| { status: "failed"; reason: string; escalation?: ConflictHunkEscalation };

// One full attempt: fetch the three trees, triage every touched path, resolve whatever
// diff3 can on its own, commit if everything resolved that way. When a file survives diff3
// with real conflict markers, extract the specific conflicting hunks and resolve those:
// mechanical hunks (both sides agree modulo whitespace) resolve for free, semantic hunks go
// through one batched LLM call, and any hunk the model isn't confident about fails the whole
// attempt rather than guessing — per INV-6, surfaced to the human queue via the "failed"
// status, same as every other unresolvable case in this function.
// Never loops or retries internally — the caller (mergeQueue.ts) decides what happens next.
export async function resolveMergeConflict(
	pr: PullRequest,
	mergeability: MergeabilityResult,
	github: GitHubClient,
	provider: LlmProvider,
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
			// A single diff3 pass gives both the conflict check and, if there's nothing to
			// resolve, the clean merge itself — no separate "is there a conflict" call needed.
			const regions = extractConflictRegions(oursContent, mergeBaseContent, theirsContent);
			const hunks = extractConflictHunks(regions);
			const resolutions = new Map<number, string>();
			const semanticHunks: ConflictHunk[] = [];
			for (const hunk of hunks) {
				if (classifyHunk(hunk) === "mechanical") {
					resolutions.set(hunk.index, resolveMechanicalHunk(hunk));
				} else {
					semanticHunks.push(hunk);
				}
			}

			if (semanticHunks.length > 0) {
				const semanticResolutions = await resolveSemanticHunks(semanticHunks, pr.declaredDirection, provider);
				// Collect every low-confidence hunk before failing, rather than stopping at the
				// first one — a file with several ambiguous hunks should disclose all of them in
				// one pass instead of making a human retry repeatedly to discover each in turn.
				const lowConfidenceReports: string[] = [];
				const lowConfidenceHunks: Array<{ hunk: ConflictHunk; resolution: SemanticHunkResolution }> = [];
				for (let i = 0; i < semanticHunks.length; i++) {
					const hunk = semanticHunks[i];
					const resolution = semanticResolutions[i];
					if (hunk === undefined || resolution === undefined) continue;
					if (resolution.confidence === "low") {
						lowConfidenceReports.push(describeLowConfidenceHunk(hunk, resolution));
						lowConfidenceHunks.push({ hunk, resolution });
						continue;
					}
					resolutions.set(hunk.index, resolution.resolution);
				}
				if (lowConfidenceReports.length > 0) {
					const plural = lowConfidenceReports.length > 1;
					return {
						status: "failed",
						reason: `${plan.path}: could not confidently resolve ${lowConfidenceReports.length} conflicting hunk${plural ? "s" : ""}:\n${lowConfidenceReports.join("\n\n")}`,
						escalation: {
							path: plan.path,
							mode: plan.mode,
							oursSha: plan.oursSha,
							theirsSha: plan.theirsSha,
							mergeBaseSha: plan.mergeBaseSha,
							lowConfidenceHunks,
						},
					};
				}
			}

			resolvedFiles.push({ path: plan.path, content: reconstructContent(regions, resolutions), mode: plan.mode });
			continue;
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
