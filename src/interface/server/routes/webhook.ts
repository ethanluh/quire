import { Router } from "express";
import type { RefreshDeps } from "../refreshRepoQueue.js";
import { enqueueRefresh, AccountChangedError } from "../refreshRepoQueue.js";

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

	return { action, repoOwner: ownerLogin, repoName, pullRequestId: String(prId), installationId };
}

// Mounted at /webhooks/github, guarded by verifyGithubSignature (HMAC, not localOnly — see
// that middleware's comment) and a raw-body parser (see index.ts wiring). Not registered at
// all unless a webhook secret is configured.
//
// findRefreshDeps resolves the tenant that owns the delivery's installation — a single
// GitHub App receives every tenant's webhook deliveries on this one endpoint, so there is
// no longer one shared RefreshDeps to fall back on (see TenantRegistry.findByInstallationId).
export function webhookRouter(findRefreshDeps: (installationId: number) => RefreshDeps | undefined): Router {
	const router = Router();

	router.post("/", (req, res) => {
		const event = req.get("x-github-event");
		if (event === "ping") {
			res.status(200).json({ pong: true });
			return;
		}
		if (event !== "pull_request") {
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
		const refreshDeps = parsed?.installationId !== undefined ? findRefreshDeps(parsed.installationId) : undefined;
		const selected = refreshDeps?.accountState.current.selectedRepo;
		if (
			parsed === undefined ||
			refreshDeps === undefined ||
			selected === undefined ||
			selected.owner !== parsed.repoOwner ||
			selected.name !== parsed.repoName ||
			!TRIGGER_ACTIONS.has(parsed.action)
		) {
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
