import { Router } from "express";
import type { RefreshDeps } from "../refreshRepoQueue.js";
import { enqueueRefresh, AccountChangedError } from "../refreshRepoQueue.js";
import { notifyStateChanged } from "../changeEvents.js";

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
		if (event !== "pull_request") {
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
				// only auto-merge if the account opted into it, otherwise just clear the
				// conflict and leave landing to a "Process" click.
				const reattempted = await refreshDeps.queue.reattemptForPr(parsed.pullRequestId);
				if (reattempted !== undefined) {
					notifyStateChanged();
					if (watchedRepo.autoMergeOnAccept === true) {
						await refreshDeps.queue.dequeueNext();
					}
				}
			}
			if (parsed.action === "closed" && parsed.merged) {
				// A human (or another tool) merged this PR directly on GitHub instead of
				// through Quire's own dequeueNext() — keep the queue's view of reality accurate
				// instead of waiting for the next Process click to notice via
				// ensureMergeable()'s alreadyMerged check.
				const updated = await refreshDeps.queue.recordExternalMerge(parsed.pullRequestId);
				if (updated !== undefined) {
					// Push the corrected merge status to the browser right away — don't wait on
					// the enqueueRefresh below, which fetches *new* PRs and can fail/be slow
					// independently of whether this merge-status update itself succeeded.
					notifyStateChanged();
					if (watchedRepo.autoMergeOnAccept === true) {
						await refreshDeps.queue.dequeueNext();
					}
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
