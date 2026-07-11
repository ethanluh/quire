import { Router } from "express";
import type { RefreshDeps } from "../refreshRepoQueue.js";
import { enqueueRefresh, AccountChangedError } from "../refreshRepoQueue.js";
import { bundleAutoMergeEnabled } from "../accountState.js";
import type { MergeQueueEntry } from "../../../engine/types/queue.js";

// The slice of a TenantContext (see tenant.ts) a webhook delivery needs once resolved by
// installation id. Kept as a narrow structural type here rather than importing
// TenantContext directly so this route stays agnostic of how a tenant is actually built.
export interface WebhookTenant {
	refreshDeps: RefreshDeps;
}

export interface WebhookConfig {
	publicUrl: string;
	secret: string;
}

// "edited" matters because a title/body change is how an undecided PR's declared-direction
// marker (and closing-keyword issue links) change — without it, fixing a forgotten marker
// doesn't update the queue until the next push or reconcile poll. "converted_to_draft" is
// the inverse of "ready_for_review": both flip the mergeability state the review card's
// badge should track promptly (the merge queue itself un-drafts before merging — see
// octokitClient.mergePullRequest — so this is about the card's view, not queue behavior).
const TRIGGER_ACTIONS = new Set([
	"opened",
	"reopened",
	"synchronize",
	"edited",
	"ready_for_review",
	"converted_to_draft",
	"closed",
]);

// GitHub webhook deliveries are at-most-once from GitHub's side but at-least-once from ours:
// a manual/scripted redelivery reuses the original X-GitHub-Delivery GUID. Remembering the
// recent ones makes a redelivery a no-op instead of a duplicate full refresh. Bounded and
// in-memory on purpose — a delivery replayed after a restart (or after 1000 newer ones) just
// redoes an idempotent refresh, so precision beyond "recent" buys nothing.
const MAX_TRACKED_DELIVERIES = 1000;

// Webhook failures after the 202 ack are otherwise lost until the reconcile poll — GitHub
// never redelivers an acked delivery. A couple of spaced retries absorb transient GitHub API
// blips (the common case) without turning the route into a job queue; anything still failing
// is logged and left to the poll.
const DEFAULT_RETRY_DELAYS_MS: ReadonlyArray<number> = [10_000, 60_000];

export interface WebhookRouterOptions {
	retryDelaysMs?: ReadonlyArray<number>;
}

function runWithRetries(label: string, delaysMs: ReadonlyArray<number>, fn: () => Promise<void>, onGiveUp?: () => void): void {
	void (async () => {
		for (let attempt = 0; ; attempt++) {
			try {
				await fn();
				return;
			} catch (err) {
				if (err instanceof AccountChangedError) {
					// Benign: the installation binding changed mid-flight, so this delivery is
					// stale by definition — retrying would race the new binding's own refresh.
					console.warn(`${label} aborted: ${err.message}`);
					return;
				}
				const delay = delaysMs[attempt];
				if (delay === undefined) {
					console.error(`${label} failed after ${attempt + 1} attempt(s); giving up until the next reconcile poll:`, err);
					onGiveUp?.();
					return;
				}
				console.warn(`${label} failed (attempt ${attempt + 1}); retrying in ${delay}ms:`, err);
				await new Promise((resolve) => setTimeout(resolve, delay).unref());
			}
		}
	})();
}

// Shared by every GitHub-side "this PR may be unblocked now" signal (a synchronize push, a
// green check_suite, an approved review): reattemptForPr only picks up a bundle actually
// blocked "conflict" on that exact PR — an unrelated PR's event is a no-op. Actually landing
// a picked-up bundle is gated the same way accept-time merging is (see gestures.ts): only
// auto-merge if every member's repo opted in, otherwise just clear the conflict and leave
// landing to a "Process" click.
async function reattemptAndMaybeAutoMerge(prIds: ReadonlyArray<string>, refreshDeps: RefreshDeps): Promise<void> {
	for (const prId of prIds) {
		const reattempted = await refreshDeps.queue.reattemptForPr(prId);
		if (reattempted !== undefined) {
			await triggerAutoMergeIfEnabled(reattempted, refreshDeps);
		}
	}
}

interface PullRequestEvent {
	action: string;
	repoOwner: string;
	repoName: string;
	pullRequestId: string;
	installationId: number | undefined;
	// Only meaningful once action === "closed" — GitHub sends this boolean on every
	// pull_request payload, but it only distinguishes a real merge from a plain close/reject
	// at that point.
	merged: boolean;
}

function parsePullRequestEvent(body: unknown): PullRequestEvent | undefined {
	if (typeof body !== "object" || body === null) return undefined;
	const record = body as Record<string, unknown>;

	const action = record["action"];
	const repository = record["repository"];
	const pullRequest = record["pull_request"];
	if (typeof action !== "string" || typeof repository !== "object" || repository === null) return undefined;
	if (typeof pullRequest !== "object" || pullRequest === null) return undefined;

	const repoRecord = repository as Record<string, unknown>;
	const owner = repoRecord["owner"];
	const repoName = repoRecord["name"];
	if (typeof owner !== "object" || owner === null || typeof repoName !== "string") return undefined;
	const ownerLogin = (owner as Record<string, unknown>)["login"];
	if (typeof ownerLogin !== "string") return undefined;

	const prId = (pullRequest as Record<string, unknown>)["id"];
	if (typeof prId !== "number") return undefined;

	// Present on every GitHub App delivery (this app has no other install type) — used to
	// route the event to the tenant whose installation it belongs to, since deliveries for
	// different tenants' installations arrive on this same shared endpoint.
	const installation = record["installation"];
	const installationIdRaw =
		typeof installation === "object" && installation !== null ? (installation as Record<string, unknown>)["id"] : undefined;
	const installationId = typeof installationIdRaw === "number" ? installationIdRaw : undefined;
	const merged = (pullRequest as Record<string, unknown>)["merged"] === true;

	return { action, repoOwner: ownerLogin, repoName, pullRequestId: String(prId), installationId, merged };
}

interface CheckSuiteEvent {
	action: string;
	repoOwner: string;
	repoName: string;
	installationId: number | undefined;
	conclusion: string | undefined;
	// Only PRs whose head branch lives in this same repo appear here (a GitHub limitation on
	// this payload field, not something Quire controls) — fork PRs simply won't self-heal via
	// this path and still need a synchronize push or a manual retry, same as today.
	pullRequestIds: ReadonlyArray<string>;
}

function parseCheckSuiteEvent(body: unknown): CheckSuiteEvent | undefined {
	if (typeof body !== "object" || body === null) return undefined;
	const record = body as Record<string, unknown>;

	const action = record["action"];
	const repository = record["repository"];
	const checkSuite = record["check_suite"];
	if (typeof action !== "string" || typeof repository !== "object" || repository === null) return undefined;
	if (typeof checkSuite !== "object" || checkSuite === null) return undefined;

	const repoRecord = repository as Record<string, unknown>;
	const owner = repoRecord["owner"];
	const repoName = repoRecord["name"];
	if (typeof owner !== "object" || owner === null || typeof repoName !== "string") return undefined;
	const ownerLogin = (owner as Record<string, unknown>)["login"];
	if (typeof ownerLogin !== "string") return undefined;

	const installation = record["installation"];
	const installationIdRaw =
		typeof installation === "object" && installation !== null ? (installation as Record<string, unknown>)["id"] : undefined;
	const installationId = typeof installationIdRaw === "number" ? installationIdRaw : undefined;

	const suiteRecord = checkSuite as Record<string, unknown>;
	const conclusion = typeof suiteRecord["conclusion"] === "string" ? (suiteRecord["conclusion"] as string) : undefined;
	const pullRequestsRaw = suiteRecord["pull_requests"];
	const pullRequestIds = Array.isArray(pullRequestsRaw)
		? pullRequestsRaw
				.map((pr) => (typeof pr === "object" && pr !== null ? (pr as Record<string, unknown>)["id"] : undefined))
				.filter((id): id is number => typeof id === "number")
				.map(String)
		: [];

	return { action, repoOwner: ownerLogin, repoName, installationId, conclusion, pullRequestIds };
}

interface PullRequestReviewEvent {
	action: string;
	repoOwner: string;
	repoName: string;
	installationId: number | undefined;
	pullRequestId: string;
	reviewState: string | undefined;
}

function parsePullRequestReviewEvent(body: unknown): PullRequestReviewEvent | undefined {
	if (typeof body !== "object" || body === null) return undefined;
	const record = body as Record<string, unknown>;

	const action = record["action"];
	const repository = record["repository"];
	const pullRequest = record["pull_request"];
	const review = record["review"];
	if (typeof action !== "string" || typeof repository !== "object" || repository === null) return undefined;
	if (typeof pullRequest !== "object" || pullRequest === null) return undefined;
	if (typeof review !== "object" || review === null) return undefined;

	const repoRecord = repository as Record<string, unknown>;
	const owner = repoRecord["owner"];
	const repoName = repoRecord["name"];
	if (typeof owner !== "object" || owner === null || typeof repoName !== "string") return undefined;
	const ownerLogin = (owner as Record<string, unknown>)["login"];
	if (typeof ownerLogin !== "string") return undefined;

	const prId = (pullRequest as Record<string, unknown>)["id"];
	if (typeof prId !== "number") return undefined;

	const installation = record["installation"];
	const installationIdRaw =
		typeof installation === "object" && installation !== null ? (installation as Record<string, unknown>)["id"] : undefined;
	const installationId = typeof installationIdRaw === "number" ? installationIdRaw : undefined;

	const reviewRecord = review as Record<string, unknown>;
	const reviewState = typeof reviewRecord["state"] === "string" ? (reviewRecord["state"] as string) : undefined;

	return { action, repoOwner: ownerLogin, repoName, installationId, pullRequestId: String(prId), reviewState };
}

// Shared by every path that clears a queue entry back to "queued" from a GitHub-side signal
// (a fresh commit, checks going green, or a direct external merge) — auto-merge only fires
// once every member's own repo has opted in (see bundleAutoMergeEnabled), same gate as
// accept-time merging in gestures.ts. No explicit notifyStateChanged() needed here: the
// caller's reattemptForPr()/recordExternalMerge() already persisted (and thus notified via
// MergeQueue's own onChanged hook) by the time `entry` reaches this function; dequeueNext()
// below notifies again itself if it changes anything further.
async function triggerAutoMergeIfEnabled(entry: MergeQueueEntry, refreshDeps: RefreshDeps): Promise<void> {
	if (bundleAutoMergeEnabled(refreshDeps.accountState.current, entry.bundle)) {
		await refreshDeps.queue.dequeueNext();
	}
}

// Mounted at /webhooks/github, guarded by verifyGithubSignature (HMAC, not localOnly — see
// that middleware's comment) and a raw-body parser (see index.ts wiring). Not registered at
// all unless a webhook secret is configured.
//
// findTenant resolves the tenant that owns the delivery's installation — a single GitHub
// App receives every tenant's webhook deliveries on this one endpoint, so there is no
// longer one shared RefreshDeps to fall back on (see TenantRegistry.findByInstallationId).
export function webhookRouter(
	findTenant: (installationId: number) => WebhookTenant | undefined,
	options: WebhookRouterOptions = {},
): Router {
	const router = Router();
	const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
	const seenDeliveries = new Set<string>();

	// Recorded only when a delivery is actually accepted for processing (the 202 paths below),
	// never on an ignore/error path — an operator's manual "Redeliver" of a delivery that
	// arrived before its tenant was bound (or that failed parsing) must be processed, not
	// swallowed as a duplicate. forgetDelivery is the give-up counterpart: once retries are
	// exhausted, redelivery becomes the operator's recovery path again.
	const recordDelivery = (deliveryId: string | undefined): void => {
		if (deliveryId === undefined) return;
		seenDeliveries.add(deliveryId);
		if (seenDeliveries.size > MAX_TRACKED_DELIVERIES) {
			const oldest = seenDeliveries.values().next().value;
			if (oldest !== undefined) seenDeliveries.delete(oldest);
		}
	};
	const forgetDelivery = (deliveryId: string | undefined): (() => void) => {
		return () => {
			if (deliveryId !== undefined) seenDeliveries.delete(deliveryId);
		};
	};

	router.post("/", (req, res) => {
		const event = req.get("x-github-event");
		const rawDeliveryId = req.get("x-github-delivery");
		const deliveryId = rawDeliveryId ?? "unknown";
		if (event === "ping") {
			res.status(200).json({ pong: true });
			return;
		}
		if (rawDeliveryId !== undefined && seenDeliveries.has(rawDeliveryId)) {
			console.log(`Webhook: already processed delivery ${rawDeliveryId} (${event ?? "unknown"}) — ignoring redelivery`);
			res.status(200).json({ ignored: true });
			return;
		}
		if (event !== "pull_request" && event !== "check_suite" && event !== "pull_request_review") {
			console.log(`Webhook: ignoring ${event ?? "unknown"} event (delivery ${deliveryId})`);
			res.status(200).json({ ignored: true });
			return;
		}

		let payload: unknown;
		try {
			payload = JSON.parse((req.body as Buffer).toString("utf8"));
		} catch {
			console.warn(`Webhook: invalid JSON in ${event} payload (delivery ${deliveryId})`);
			res.status(400).json({ error: "Invalid JSON payload" });
			return;
		}

		if (event === "check_suite") {
			const parsedSuite = parseCheckSuiteEvent(payload);
			if (parsedSuite === undefined) {
				console.warn(`Webhook: could not parse check_suite payload (delivery ${deliveryId})`);
				res.status(200).json({ ignored: true });
				return;
			}
			const suiteTenant = parsedSuite.installationId !== undefined ? findTenant(parsedSuite.installationId) : undefined;
			const suiteRefreshDeps = suiteTenant?.refreshDeps;
			if (suiteRefreshDeps === undefined) {
				console.warn(
					`Webhook: no tenant bound to installation ${parsedSuite.installationId ?? "missing"} (check_suite on ${parsedSuite.repoOwner}/${parsedSuite.repoName}, delivery ${deliveryId})`,
				);
				res.status(200).json({ ignored: true });
				return;
			}
			const suiteWatchedRepo = suiteRefreshDeps.accountState.current.repos.find(
				(r) => r.owner === parsedSuite.repoOwner && r.name === parsedSuite.repoName,
			);
			if (suiteWatchedRepo === undefined) {
				console.warn(
					`Webhook: ${parsedSuite.repoOwner}/${parsedSuite.repoName} is not a watched repo for installation ${parsedSuite.installationId} (delivery ${deliveryId}) — ignoring check_suite`,
				);
				res.status(200).json({ ignored: true });
				return;
			}
			// Checks turning green is only worth acting on once every check in the suite has
			// finished and none failed — a suite still "in_progress", or one that failed/was
			// cancelled, leaves the entry exactly where it was for a human (or a later green
			// check_suite) to deal with. High-volume, expected traffic — not worth a log line.
			if (parsedSuite.action !== "completed" || parsedSuite.conclusion !== "success") {
				res.status(200).json({ ignored: true });
				return;
			}

			recordDelivery(rawDeliveryId);
			res.status(202).json({ accepted: true });
			runWithRetries(
				`Webhook-triggered check_suite reattempt for ${parsedSuite.repoOwner}/${parsedSuite.repoName}`,
				retryDelaysMs,
				() => reattemptAndMaybeAutoMerge(parsedSuite.pullRequestIds, suiteRefreshDeps),
				forgetDelivery(rawDeliveryId),
			);
			return;
		}

		if (event === "pull_request_review") {
			const parsedReview = parsePullRequestReviewEvent(payload);
			if (parsedReview === undefined) {
				console.warn(`Webhook: could not parse pull_request_review payload (delivery ${deliveryId})`);
				res.status(200).json({ ignored: true });
				return;
			}
			const reviewTenant = parsedReview.installationId !== undefined ? findTenant(parsedReview.installationId) : undefined;
			const reviewRefreshDeps = reviewTenant?.refreshDeps;
			if (reviewRefreshDeps === undefined) {
				console.warn(
					`Webhook: no tenant bound to installation ${parsedReview.installationId ?? "missing"} (pull_request_review on ${parsedReview.repoOwner}/${parsedReview.repoName}#${parsedReview.pullRequestId}, delivery ${deliveryId})`,
				);
				res.status(200).json({ ignored: true });
				return;
			}
			const reviewWatchedRepo = reviewRefreshDeps.accountState.current.repos.find(
				(r) => r.owner === parsedReview.repoOwner && r.name === parsedReview.repoName,
			);
			if (reviewWatchedRepo === undefined) {
				console.warn(
					`Webhook: ${parsedReview.repoOwner}/${parsedReview.repoName} is not a watched repo for installation ${parsedReview.installationId} (delivery ${deliveryId}) — ignoring pull_request_review`,
				);
				res.status(200).json({ ignored: true });
				return;
			}
			// Only a submitted approval is worth re-checking — a comment, change request, or a
			// dismissal can only ever make branch protection stricter, never clear a "blocked"
			// entry, and any queued (not yet "conflict") entry it affects gets re-diagnosed the
			// normal way on its next dequeueNext() pass anyway. High-volume, expected traffic —
			// not worth a log line.
			if (parsedReview.action !== "submitted" || parsedReview.reviewState !== "approved") {
				res.status(200).json({ ignored: true });
				return;
			}

			recordDelivery(rawDeliveryId);
			res.status(202).json({ accepted: true });
			runWithRetries(
				`Webhook-triggered pull_request_review reattempt for ${parsedReview.repoOwner}/${parsedReview.repoName}`,
				retryDelaysMs,
				() => reattemptAndMaybeAutoMerge([parsedReview.pullRequestId], reviewRefreshDeps),
				forgetDelivery(rawDeliveryId),
			);
			return;
		}

		const parsed = parsePullRequestEvent(payload);
		if (parsed === undefined) {
			console.warn(`Webhook: could not parse pull_request payload (delivery ${deliveryId})`);
			res.status(200).json({ ignored: true });
			return;
		}
		const tenant = parsed.installationId !== undefined ? findTenant(parsed.installationId) : undefined;
		const refreshDeps = tenant?.refreshDeps;
		if (refreshDeps === undefined) {
			console.warn(
				`Webhook: no tenant bound to installation ${parsed.installationId ?? "missing"} (${parsed.repoOwner}/${parsed.repoName}#${parsed.pullRequestId}, delivery ${deliveryId})`,
			);
			res.status(200).json({ ignored: true });
			return;
		}
		const watchedRepo = refreshDeps.accountState.current.repos.find((r) => r.owner === parsed.repoOwner && r.name === parsed.repoName);
		if (watchedRepo === undefined) {
			console.warn(
				`Webhook: ${parsed.repoOwner}/${parsed.repoName} is not a watched repo for installation ${parsed.installationId} (delivery ${deliveryId}) — ignoring ${parsed.action}`,
			);
			res.status(200).json({ ignored: true });
			return;
		}
		if (!TRIGGER_ACTIONS.has(parsed.action)) {
			// High-volume, expected traffic (labeled/review_requested/etc.) — not worth a log line.
			res.status(200).json({ ignored: true });
			return;
		}

		// GitHub expects an ack within ~10s and doesn't wait for the ingest pipeline (LLM
		// extraction, clustering) to finish — acknowledge immediately, refresh after.
		recordDelivery(rawDeliveryId);
		res.status(202).json({ accepted: true });

		// Every step below is idempotent against GitHub's authoritative state (clearDecided,
		// reattemptForPr, recordExternalMerge/Close, and the full re-fetch in enqueueRefresh
		// all converge on the same result when re-run — even the auto-merge path re-checks
		// mergeability and skips already-merged PRs), so the whole delivery is safe to retry
		// as a unit after a partial failure.
		runWithRetries(
			`Webhook-triggered refresh for ${parsed.repoOwner}/${parsed.repoName}`,
			retryDelaysMs,
			async () => {
				if (parsed.action === "synchronize") {
					// New commits on a previously-decided PR (e.g. rejected, then reworked)
					// deserve fresh review instead of staying permanently excluded. (A body-only
					// "edited" event deliberately does NOT clear the decision — fixing a marker
					// without new commits shouldn't resurrect a rejected PR.)
					await refreshDeps.decidedStore.clearDecided(parsed.pullRequestId);

					// New commits may be exactly what a fleet was asked to push after a flagged
					// conflict (or a human's own fix) — pick the stuck bundle back up instead of
					// leaving it in "conflict" until someone notices and clicks "Retry".
					await reattemptAndMaybeAutoMerge([parsed.pullRequestId], refreshDeps);
				}
				if (parsed.action === "closed" && parsed.merged) {
					// A human (or another tool) merged this PR directly on GitHub instead of
					// through Quire's own dequeueNext() — keep the queue's view of reality accurate
					// instead of waiting for the next Process click to notice via
					// ensureMergeable()'s alreadyMerged check. Push the corrected merge status to the
					// browser right away — don't wait on the enqueueRefresh below, which fetches
					// *new* PRs and can fail/be slow independently of whether this update succeeded.
					const updated = await refreshDeps.queue.recordExternalMerge(parsed.pullRequestId);
					if (updated !== undefined) {
						await triggerAutoMergeIfEnabled(updated, refreshDeps);
					}
				} else if (parsed.action === "closed" && !parsed.merged) {
					// Closed without merging — a member PR this queue entry needed is gone, so the
					// bundle can never fully land. Record it as "closed" instead of leaving the entry
					// to poll/retry forever against a PR that will never become mergeable. No
					// auto-merge trigger: closing isn't a landing event.
					await refreshDeps.queue.recordExternalClose(parsed.pullRequestId);
				}
				await enqueueRefresh(parsed.repoOwner, parsed.repoName, refreshDeps);
			},
			forgetDelivery(rawDeliveryId),
		);
	});

	return router;
}
