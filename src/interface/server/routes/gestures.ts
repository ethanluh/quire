import { Router } from "express";
import { z } from "zod";
import type { MergeQueue } from "../../../engine/queue/mergeQueue.js";
import type { GitHubClient } from "../../../engine/github/client.js";
import type { Bundle, GestureAction, ReviewCard } from "../../../engine/types/core.js";
import type { ServerState } from "../state.js";
import { logDefer } from "../../../engine/instrumentation/logger.js";
import { validateBody } from "../middleware/validation.js";

const GestureSchema = z.object({
	action: z.enum(["accept", "defer", "reject"]),
});

// Posted per PR in the bundle (not once per bundle) so the swarm agent that authored
// each PR sees the verdict directly on its own PR. A single failed post must not sink
// the others, since the gesture itself has already been applied to local state.
async function postCardToMembers(
	github: GitHubClient,
	action: GestureAction,
	bundle: Bundle,
	card: ReviewCard,
): Promise<void> {
	await Promise.all(
		bundle.members.map(async (pr) => {
			try {
				await github.postReviewCardComment(pr.repoOwner, pr.repoName, pr.number, action, card);
			} catch (err) {
				console.error(
					`Failed to post review card comment to ${pr.repoOwner}/${pr.repoName}#${pr.number}: ${String(err)}`,
				);
			}
		}),
	);
}

export function gesturesRouter(
	state: ServerState,
	queue: MergeQueue,
	deferLogPath: string,
	github: GitHubClient,
): Router {
	const router = Router({ mergeParams: true });

	router.post(
		"/:bundleId/gesture",
		validateBody(GestureSchema),
		async (req, res, next) => {
			try {
				const bundleId = req.params["bundleId"] ?? "";
				const bundle = state.bundles.get(bundleId);
				const card = state.cards.get(bundleId);

				if (bundle === undefined || card === undefined) {
					res.status(404).json({ error: "Bundle not found" });
					return;
				}

				const { action } = req.body as z.infer<typeof GestureSchema>;

				if (action === "accept") {
					await queue.enqueue(bundle); // enqueues, does not merge (INV-5)
					state.bundles.delete(bundleId);
					state.cards.delete(bundleId);
					await postCardToMembers(github, action, bundle, card);
					res.json({ status: "queued", bundleId });
				} else if (action === "reject") {
					state.bundles.delete(bundleId);
					state.cards.delete(bundleId);
					await postCardToMembers(github, action, bundle, card);
					res.json({ status: "rejected", bundleId });
				} else {
					// defer
					state.shelf.set(bundleId, card);
					state.cards.delete(bundleId);
					await logDefer(deferLogPath, bundleId, card);
					await postCardToMembers(github, action, bundle, card);
					res.json({ status: "deferred", bundleId, shelfPosition: state.shelf.size });
				}
			} catch (err) {
				next(err);
			}
		},
	);

	return router;
}
