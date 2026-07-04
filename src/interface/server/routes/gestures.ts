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
import { notifyStateChanged } from "../changeEvents.js";

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

				const login = res.locals.login;
				const membership = res.locals.membership;
				if (login === undefined || membership === undefined) {
					res.status(401).json({ error: "Sign in required" });
					return;
				}

				// Owner/admin, not owner-only: matches the same privilege level requireRole grants
				// for membership management, since assignment is an organizational/triage-routing
				// concern rather than a merge-queue-technical one (queue.process/settings stay
				// owner-only elsewhere).
				const isPrivileged = membership.role === "owner" || membership.role === "admin";
				const forceRequested = req.query["force"] === "true";
				let overrodeAssignment = false;

				if (bundle.assignedTo !== undefined && bundle.assignedTo !== login) {
					if (!isPrivileged) {
						res.status(403).json({ error: "This bundle is assigned to another team member", assignedTo: bundle.assignedTo });
						return;
					}
					if (!forceRequested) {
						res.status(409).json({
							error:
								"This bundle is assigned to another team member. Reassign it to yourself first, or retry with force=true to override.",
							assignedTo: bundle.assignedTo,
						});
						return;
					}
					overrodeAssignment = true;
				}

				const wasAssignedTo = bundle.assignedTo;
				// Self-assign-on-gesture: stamped unconditionally, whether or not the gate above
				// fired — this correctly handles both "already mine" (harmless re-stamp) and "was
				// unassigned" (first stamp) in one path, rather than branching on assignedTo again.
				const assignedBundle: Bundle = {
					...bundle,
					assignedTo: login,
					assignedAt: new Date().toISOString(),
					assignedBy: login,
				};

				const { action } = req.body as z.infer<typeof GestureSchema>;
				const memberPrIds = bundle.members.map((m) => m.id);
				// wasAssignedTo omitted entirely (not set to undefined) when the bundle had no prior
				// assignee — exactOptionalPropertyTypes distinguishes "key absent" from "key: undefined".
				const decisionContext = {
					decidedBy: login,
					bundleId,
					overrodeAssignment,
					...(wasAssignedTo !== undefined ? { wasAssignedTo } : {}),
				};

				if (action === "accept") {
					await queue.enqueue(assignedBundle, card); // enqueues; merge (if any) happens below, not inline
					state.bundles.delete(bundleId);
					state.cards.delete(bundleId);
					await decidedStore.markDecided(memberPrIds, action, decisionContext);
					postCardToMembers(github, action, assignedBundle, card);
					// autoMergeOnAccept is itself owner-gated (POST /account/github/settings requires
					// requireRole("owner")) — turning it on IS the authorization decision for every
					// accept that follows to drain the queue, deliberately, regardless of which member
					// performs the accept. This route itself stays open to every member on purpose
					// (INV-5: an unaccepted bundle never merges), and dequeueNext only ever processes
					// bundles someone has already accepted, whether that's this one or another already
					// waiting in the shared queue.
					if (accountState.current?.autoMergeOnAccept === true) {
						// Don't block the response on the full merge (GitHub mergeability polling can
						// take many seconds) — the bundle must appear in the merge queue immediately.
						// The merge progresses in the background; notifyStateChanged() wakes any open
						// SSE connection once it settles instead of making them wait for the next poll.
						queue
							.dequeueNext()
							.catch((err: unknown) => console.error(`Background auto-merge failed for ${bundleId}:`, err))
							.finally(() => notifyStateChanged());
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
					await decidedStore.markDecided(memberPrIds, action, decisionContext);
					postCardToMembers(github, action, assignedBundle, card);
					res.json({ status: "rejected", bundleId });
				} else {
					// defer
					state.shelf.set(bundleId, { card, bundle: assignedBundle, memberPrIds });
					state.cards.delete(bundleId);
					await decidedStore.markDecided(memberPrIds, action, decisionContext);
					await logDefer(deferLogPath, bundleId, card);
					postCardToMembers(github, action, assignedBundle, card);
					res.json({ status: "deferred", bundleId, shelfPosition: state.shelf.size });
				}
			} catch (err) {
				next(err);
			}
		},
	);

	return router;
}
