import { Router } from "express";
import { z } from "zod";
import type { MergeQueue } from "../../../engine/queue/mergeQueue.js";
import type { DecidedPrStore } from "../../../engine/queue/decidedPrStore.js";
import type { ServerState } from "../state.js";
import { requireRole } from "../middleware/requireRole.js";
import { validateBody } from "../middleware/validation.js";
import type { AccountState } from "../accountState.js";
import { bundleAutoMergeEnabled } from "../accountState.js";
// MergeQueue now notifies on every persisted mutation itself (see its onChanged hook, wired
// in tenant.ts) — the only place this route still needs to notify explicitly is DELETE
// /:bundleId below, which also mutates ServerState's review queue, a change the queue's own
// hook has no visibility into.
import { notifyStateChanged } from "../changeEvents.js";

// Path taken via the request body, not a URL segment — a file path routinely contains
// slashes, which a URL param can't carry reliably under Express 4's default path matching.
const InvestigationPathSchema = z.object({ path: z.string().min(1) });

export function queueRouter(
	queue: MergeQueue,
	state: ServerState,
	decidedStore: DecidedPrStore,
	accountState: AccountState,
	teamId: string,
): Router {
	const router = Router();

	router.get("/", async (_req, res, next) => {
		try {
			res.json(await queue.listEntries());
		} catch (err) {
			next(err);
		}
	});

	// Everything below actually mutates the shared merge queue (merges, reverts, requeues,
	// pulls a bundle back to review) — restricted to the team's owner. Everyday triage (the
	// accept/defer/reject gestures) stays open to every member; accept only enqueues, EXCEPT
	// when the owner has turned on autoMergeOnAccept (itself gated to requireRole("owner") —
	// see routes/githubApp.ts), in which case any member's accept also drains the queue the
	// same way /process below does. See gestures.ts for that interaction.
	router.post("/process", requireRole("owner"), async (_req, res, next) => {
		try {
			const entry = await queue.dequeueNext();
			if (entry === undefined) {
				res.json({ status: "empty" });
			} else {
				// entry.status reflects the real outcome — "landed" or, since a member PR
				// couldn't be made mergeable, "conflict" (with entry.conflict disclosing why).
				res.json({ status: entry.status, bundleId: entry.bundleId, ...(entry.conflict !== undefined ? { conflict: entry.conflict } : {}) });
			}
		} catch (err) {
			next(err);
		}
	});

	// A bundle stuck in "conflict" (automated resolution didn't apply or couldn't confidently
	// resolve it — see INV-6) or "aborted" (a human gave up on it earlier) is retried right
	// away, same as /process — the response's status reflects the real outcome ("landed",
	// "conflict" again, or "investigating"), not just a requeue. Same autoMergeOnAccept
	// follow-through as /investigation/accept below: if every member's repo has it on, don't
	// make the human click /process too — keep draining the rest of the queue in the
	// background the same way a fresh conflict-clearing commit would.
	router.post("/:bundleId/retry", requireRole("owner"), async (req, res, next) => {
		try {
			const bundleId = req.params["bundleId"] ?? "";
			const retried = await queue.reattempt(bundleId);
			if (retried === undefined) {
				res.status(400).json({ error: `Bundle ${bundleId} is not in a conflict or aborted state` });
				return;
			}
			if (bundleAutoMergeEnabled(accountState.current, retried.bundle)) {
				queue.dequeueNext().catch((err: unknown) => console.error(`Background auto-merge failed for ${bundleId}:`, err));
			}
			res.json({ status: retried.status, bundleId, ...(retried.conflict !== undefined ? { conflict: retried.conflict } : {}) });
		} catch (err) {
			next(err);
		}
	});

	// A bundle stuck mid-landing (possibly with some members already merged) or blocked on
	// conflict — the human is giving up on it rather than continuing to retry. Does not
	// revert mergedPrIds (see MergeQueue.abort); a separate DELETE /:bundleId/prs/:prId call
	// handles that per PR.
	router.post("/:bundleId/abort", requireRole("owner"), async (req, res, next) => {
		try {
			const bundleId = req.params["bundleId"] ?? "";
			const aborted = await queue.abort(bundleId);
			if (aborted === undefined) {
				res.status(400).json({ error: `Bundle ${bundleId} is not in an abortable state` });
				return;
			}
			res.json({ status: "aborted", bundleId });
		} catch (err) {
			next(err);
		}
	});

	// Applies a Managed Agents decision packet's proposed resolution and requeues the bundle
	// (see MergeQueue.acceptInvestigation) — never auto-applied regardless of the packet's own
	// self-reported confidence; a human always accepts or rejects explicitly. Mutates the
	// shared queue like everything else in this file, so it's owner-gated the same way. Same
	// autoMergeOnAccept follow-through as /retry above — accepting a resolution is the human
	// equivalent of a conflict-clearing commit.
	router.post("/:bundleId/investigation/accept", requireRole("owner"), validateBody(InvestigationPathSchema), async (req, res, next) => {
		try {
			const bundleId = req.params["bundleId"] ?? "";
			const { path } = req.body as z.infer<typeof InvestigationPathSchema>;
			const updated = await queue.acceptInvestigation(bundleId, path);
			if (updated === undefined) {
				res.status(400).json({ error: `No awaiting-review investigation for ${path} on bundle ${bundleId}` });
				return;
			}
			if (bundleAutoMergeEnabled(accountState.current, updated.bundle)) {
				queue.dequeueNext().catch((err: unknown) => console.error(`Background auto-merge failed for ${bundleId}:`, err));
			}
			res.json({ status: "queued", bundleId });
		} catch (err) {
			next(err);
		}
	});

	router.post("/:bundleId/investigation/reject", requireRole("owner"), validateBody(InvestigationPathSchema), async (req, res, next) => {
		try {
			const bundleId = req.params["bundleId"] ?? "";
			const { path } = req.body as z.infer<typeof InvestigationPathSchema>;
			const updated = await queue.rejectInvestigation(bundleId, path);
			if (updated === undefined) {
				res.status(400).json({ error: `No awaiting-review investigation for ${path} on bundle ${bundleId}` });
				return;
			}
			res.json({ status: "conflict", bundleId });
		} catch (err) {
			next(err);
		}
	});

	router.delete("/:bundleId/prs/:prId", requireRole("owner"), async (req, res, next) => {
		try {
			const bundleId = req.params["bundleId"] ?? "";
			const prId = req.params["prId"] ?? "";
			const url = await queue.revertPr(bundleId, prId);
			res.json({ status: "reverted", revertUrl: url });
		} catch (err) {
			next(err);
		}
	});

	router.delete("/:bundleId", requireRole("owner"), async (req, res, next) => {
		try {
			const bundleId = req.params["bundleId"] ?? "";
			const removed = await queue.removeQueued(bundleId);
			if (removed === undefined) {
				res.json({ status: "removed" }); // not found, or already past "queued" — same no-op as today
				return;
			}
			notifyStateChanged(teamId);
			if (removed.card !== undefined) {
				// Restore to the review queue (INV-5: an accept must stay reversible until the
				// queue lands it), with the exact card the human already saw.
				state.cards.set(bundleId, removed.card);
				state.bundles.set(bundleId, removed.bundle);
				for (const pr of removed.bundle.members) {
					await decidedStore.clearDecided(pr.id);
				}
				res.json({ status: "restored", bundleId });
				return;
			}
			// Legacy entry with no stored card — nothing to restore into the review queue.
			res.json({ status: "removed", bundleId });
		} catch (err) {
			next(err);
		}
	});

	return router;
}
