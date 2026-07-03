import { timingSafeEqual } from "node:crypto";
import { Router } from "express";
import type { MergeQueue } from "../../../engine/queue/mergeQueue.js";
import { logConflictResolution } from "../../../engine/instrumentation/logger.js";
import { notifyStateChanged } from "../changeEvents.js";

const CALLBACK_TOKEN_HEADER = "x-quire-callback-token";

interface ActionCallbackPayload {
	outcome: "resolved" | "unresolved";
	reason?: string;
}

function parsePayload(body: unknown): ActionCallbackPayload | undefined {
	if (typeof body !== "object" || body === null) return undefined;
	const record = body as Record<string, unknown>;
	const outcome = record["outcome"];
	if (outcome === "resolved") return { outcome };
	if (outcome === "unresolved") {
		const reason = record["reason"];
		return { outcome, reason: typeof reason === "string" ? reason : "unresolved (no reason given)" };
	}
	return undefined;
}

// Constant-time compare against a per-dispatch capability token, not a shared secret — see
// conflictResolution.ts's resolveMergeConflict, which mints a random token per dispatch and
// stores it only on that one queue entry. A mismatched length fails closed rather than
// throwing (mirrors middleware/webhookSignature.ts's isValidSignature).
function tokensMatch(provided: string, expected: string): boolean {
	const providedBuf = Buffer.from(provided, "utf8");
	const expectedBuf = Buffer.from(expected, "utf8");
	if (providedBuf.length !== expectedBuf.length) return false;
	return timingSafeEqual(providedBuf, expectedBuf);
}

// Mounted at /callbacks/action-resolution, before the session middleware (see index.ts) — a
// GitHub Actions runner calls this, not a logged-in user, so the trust boundary is the
// per-dispatch token rather than a session cookie or GitHub's own HMAC.
export function actionCallbackRouter(queue: MergeQueue, conflictLogPath: string): Router {
	const router = Router();

	router.post("/:bundleId/resolution", async (req, res, next) => {
		try {
			const bundleId = req.params["bundleId"] ?? "";
			const token = req.get(CALLBACK_TOKEN_HEADER);

			const entry = await queue.getEntry(bundleId);
			if (entry === undefined || entry.status !== "resolving" || entry.resolution === undefined) {
				res.status(404).json({ error: "No pending resolution for this bundle" });
				return;
			}
			if (token === undefined || !tokensMatch(token, entry.resolution.callbackToken)) {
				res.status(401).json({ error: "Invalid callback token" });
				return;
			}

			const payload = parsePayload(req.body);
			if (payload === undefined) {
				res.status(400).json({ error: 'Body must be {"outcome":"resolved"} or {"outcome":"unresolved","reason":string}' });
				return;
			}

			const { prId } = entry.resolution;

			if (payload.outcome === "unresolved") {
				await queue.markResolutionFailed(bundleId, prId, payload.reason ?? "unresolved (no reason given)");
				await logConflictResolution(conflictLogPath, bundleId, prId, "unresolved", payload.reason);
				res.status(200).json({ acknowledged: true });
				// This is a GitHub Actions runner calling in, not an open tab — nothing else
				// already knows this queue entry changed, so push it rather than wait for a poll.
				notifyStateChanged();
				return;
			}

			// The workflow already committed and pushed the resolved content directly to the
			// PR's head branch — Quire's job now is just to re-attempt the merge.
			await queue.markResolutionSucceeded(bundleId);
			await logConflictResolution(conflictLogPath, bundleId, prId, "resolved");
			res.status(200).json({ acknowledged: true });
			notifyStateChanged();

			// Auto-continue the queue rather than waiting for a human to notice the status
			// changed and click "Process" — mirrors the webhook route's fire-and-forget refresh.
			queue.dequeueNext()
				.catch((err: unknown) => {
					console.error(`Auto-continue after conflict resolution failed for bundle ${bundleId}:`, err);
				})
				.finally(() => notifyStateChanged());
		} catch (err) {
			next(err);
		}
	});

	return router;
}
