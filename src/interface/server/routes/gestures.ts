import { Router } from "express";
import { z } from "zod";
import type { MergeQueue } from "../../../engine/queue/mergeQueue.js";
import type { GitHubClient } from "../../../engine/github/client.js";
import type { DecidedPrStore } from "../../../engine/queue/decidedPrStore.js";
import type { Bundle, GestureAction, ReviewCard } from "../../../engine/types/core.js";
import type { ServerState } from "../state.js";
import type { AccountState } from "../accountState.js";
import { logDefer } from "../../../engine/instrumentation/logger.js";
import { validateBody } from "../middleware/validation.js";

const GestureSchema = z.object({
	action: z.enum(["accept", "defer", "reject"]),
});

// Posted per PR in the bundle (not once per bundle) so the swarm agent that authored
// each PR sees the verdict directly on its own PR. Fire-and-forget: the gesture has
// already been applied to local state by the time this runs, so a comment failure
// must never surface as a failed response for an action that already succeeded.
function postCardToMembers(
	github: GitHubClient,
	action: GestureAction,
	bundle: Bundle,
	card: ReviewCard,
): void {
	for (const pr of bundle.members) {
		github.postReviewCardComment(pr.repoOwner, pr.repoName, pr.number, action, card).catch((err: unknown) => {
			console.error(`Failed to post review card comment to ${pr.repoOwner}/${pr.repoName}#${pr.number}:`, err);
		});
	}
}

export function gesturesRouter(
	state: ServerState,
	queue: MergeQueue,
	deferLogPath: string,
	github: GitHubClient,
	decidedStore: DecidedPrStore,
	accountState: AccountState,
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
				const memberPrIds = bundle.members.map((m) => m.id);

				if (action === "accept") {
					await queue.enqueue(bundle, card); // enqueues, does not merge (INV-5, unless autoMergeOnAccept)
					state.bundles.delete(bundleId);
					state.cards.delete(bundleId);
					await decidedStore.markDecided(memberPrIds, action);
					postCardToMembers(github, action, bundle, card);
					// autoMergeOnAccept is itself owner-gated (POST /account/github/settings requires
					// requireRole("owner")) — turning it on IS the authorization decision for every
					// accept that follows to drain the queue, deliberately, regardless of which member
					// performs the accept. This route itself stays open to every member on purpose
					// (INV-5: an unaccepted bundle never merges), and dequeueNext only ever processes
					// bundles someone has already accepted, whether that's this one or another already
					// waiting in the shared queue.
					if (accountState.current?.autoMergeOnAccept === true) {
						const landed = await queue.dequeueNext();
						res.json({ status: landed?.status ?? "queued", bundleId: landed?.bundleId ?? bundleId });
						return;
					}
					res.json({ status: "queued", bundleId });
				} else if (action === "reject") {
					// Close each member PR on GitHub before touching local state, so a GitHub-side
					// failure leaves the bundle in the review queue for retry instead of the
					// verdict being silently lost while the PR stays open forever.
					for (const pr of bundle.members) {
						await github.closePullRequest(pr.repoOwner, pr.repoName, pr.number);
					}
					state.bundles.delete(bundleId);
					state.cards.delete(bundleId);
					await decidedStore.markDecided(memberPrIds, action);
					postCardToMembers(github, action, bundle, card);
					res.json({ status: "rejected", bundleId });
				} else {
					// defer
					state.shelf.set(bundleId, { card, bundle, memberPrIds });
					state.cards.delete(bundleId);
					await decidedStore.markDecided(memberPrIds, action);
					await logDefer(deferLogPath, bundleId, card);
					postCardToMembers(github, action, bundle, card);
					res.json({ status: "deferred", bundleId, shelfPosition: state.shelf.size });
				}
			} catch (err) {
				next(err);
			}
		},
	);

	return router;
}
