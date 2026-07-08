import { Router } from "express";
import type { RefreshDeps } from "../refreshRepoQueue.js";
import { enqueueRefresh, AccountChangedError } from "../refreshRepoQueue.js";
import { notifyStateChanged } from "../changeEvents.js";
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

const TRIGGER_ACTIONS = new Set(["opened", "reopened", "synchronize", "ready_for_review", "closed"]);

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

// Shared by every path that clears a queue entry back to "queued" from a GitHub-side signal
// (a fresh commit, checks going green, or a direct external merge) — auto-merge only fires
// once every member's own repo has opted in (see bundleAutoMergeEnabled), same gate as
// accept-time merging in gestures.ts.
async function triggerAutoMergeIfEnabled(entry: MergeQueueEntry, refreshDeps: RefreshDeps): Promise<void> {
	notifyStateChanged();
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
export function webhookRouter(findTenant: (installationId: number) => WebhookTenant | undefined): Router {
	const router = Router();

	router.post("/", (req, res) => {
		const event = req.get("x-github-event");
		const deliveryId = req.get("x-github-delivery") ?? "unknown";
		if (event === "ping") {
			res.status(200).json({ pong: true });
			return;
		}
		if (event !== "pull_request" && event !== "check_suite") {
			console.log(`Webhook: ignoring ${event ?? "unknown"} event (delivery ${deliveryId})`);
			res.status(200).json({ ignored: true });
			return;
		}

		let payload: unknown;
		try {
			payload = JSON.parse((req.body as Buffer).toString("utf8"));
		} catch {
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
				res.status(200).json({ ignored: true });
				return;
			}
			const suiteWatchedRepo = suiteRefreshDeps.accountState.current.repos.find(
				(r) => r.owner === parsedSuite.repoOwner && r.name === parsedSuite.repoName,
			);
			// Checks turning green is only worth acting on once every check in the suite has
			// finished and none failed — a suite still "in_progress", or one that failed/was
			// cancelled, leaves the entry exactly where it was for a human (or a later green
			// check_suite) to deal with.
			if (suiteWatchedRepo === undefined || parsedSuite.action !== "completed" || parsedSuite.conclusion !== "success") {
				res.status(200).json({ ignored: true });
				return;
			}

			res.status(202).json({ accepted: true });
			(async () => {
				for (const prId of parsedSuite.pullRequestIds) {
					// Same reattemptForPr as a synchronize push: only picks up a bundle actually
					// blocked "conflict" on this exact PR (e.g. kind "unstable" from failing/
					// pending checks) — an unrelated PR whose checks happen to finish is a no-op.
					const reattempted = await suiteRefreshDeps.queue.reattemptForPr(prId);
					if (reattempted !== undefined) {
						await triggerAutoMergeIfEnabled(reattempted, suiteRefreshDeps);
					}
				}
			})().catch((err: unknown) => {
				console.error(`Webhook-triggered check_suite reattempt failed for ${parsedSuite.repoOwner}/${parsedSuite.repoName}:`, err);
			});
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
		res.status(202).json({ accepted: true });

		(async () => {
			if (parsed.action === "synchronize") {
				// New commits on a previously-decided PR (e.g. rejected, then reworked)
				// deserve fresh review instead of staying permanently excluded.
				await refreshDeps.decidedStore.clearDecided(parsed.pullRequestId);

				// New commits may be exactly what a fleet was asked to push after a flagged
				// conflict (or a human's own fix) — pick the stuck bundle back up instead of
				// leaving it in "conflict" until someone notices and clicks "Retry". Actually
				// landing it is gated the same way accept-time merging is (see gestures.ts):
				// only auto-merge if every member's repo opted in, otherwise just clear the
				// conflict and leave landing to a "Process" click.
				const reattempted = await refreshDeps.queue.reattemptForPr(parsed.pullRequestId);
				if (reattempted !== undefined) {
					await triggerAutoMergeIfEnabled(reattempted, refreshDeps);
				}
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
			}
			await enqueueRefresh(parsed.repoOwner, parsed.repoName, refreshDeps);
		})().catch((err: unknown) => {
			if (err instanceof AccountChangedError) {
				console.warn(`Webhook-triggered refresh for ${parsed.repoOwner}/${parsed.repoName} aborted: ${err.message}`);
				return;
			}
			console.error(`Webhook-triggered refresh failed for ${parsed.repoOwner}/${parsed.repoName}:`, err);
		});
	});

	return router;
}
