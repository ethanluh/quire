import { Router } from "express";
import type { RefreshDeps } from "../refreshRepoQueue.js";
import { enqueueRefresh, AccountChangedError } from "../refreshRepoQueue.js";
import type { MergeQueue } from "../../../engine/queue/mergeQueue.js";
import { logConflictResolution } from "../../../engine/instrumentation/logger.js";

// The slice of a TenantContext (see tenant.ts) a webhook delivery needs once resolved by
// installation id — just refreshDeps for pull_request events, plus queue/conflictLogPath
// for workflow_run events. Kept as a narrow structural type here rather than importing
// TenantContext directly so this route stays agnostic of how a tenant is actually built.
export interface WebhookTenant {
	refreshDeps: RefreshDeps;
	queue: MergeQueue;
	conflictLogPath: string;
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

interface WorkflowRunEvent {
	status: string;
	conclusion: string | undefined;
	workflowRunId: number;
	repoOwner: string;
	repoName: string;
	installationId: number | undefined;
}

function parseWorkflowRunEvent(body: unknown): WorkflowRunEvent | undefined {
	if (typeof body !== "object" || body === null) return undefined;
	const record = body as Record<string, unknown>;

	const workflowRun = record["workflow_run"];
	const repository = record["repository"];
	if (typeof workflowRun !== "object" || workflowRun === null) return undefined;
	if (typeof repository !== "object" || repository === null) return undefined;

	const runRecord = workflowRun as Record<string, unknown>;
	const id = runRecord["id"];
	const status = runRecord["status"];
	const conclusion = runRecord["conclusion"];
	if (typeof id !== "number" || typeof status !== "string") return undefined;
	if (conclusion !== null && typeof conclusion !== "string") return undefined;

	const repoRecord = repository as Record<string, unknown>;
	const owner = repoRecord["owner"];
	const repoName = repoRecord["name"];
	if (typeof owner !== "object" || owner === null || typeof repoName !== "string") return undefined;
	const ownerLogin = (owner as Record<string, unknown>)["login"];
	if (typeof ownerLogin !== "string") return undefined;

	// Same App-delivery guarantee as parsePullRequestEvent — used to route this delivery to
	// the tenant whose installation it belongs to.
	const installation = record["installation"];
	const installationIdRaw =
		typeof installation === "object" && installation !== null ? (installation as Record<string, unknown>)["id"] : undefined;
	const installationId = typeof installationIdRaw === "number" ? installationIdRaw : undefined;

	return {
		workflowRunId: id,
		status,
		conclusion: conclusion ?? undefined,
		repoOwner: ownerLogin,
		repoName,
		installationId,
	};
}

// A completed, non-successful run is the one case the Action's own callback (routes/
// actionCallback.ts) can't be relied on for — it's the last step of the job, so a run that
// fails or is cancelled earlier never reaches it. Success is deliberately not acted on here:
// the job can succeed while still reporting "unresolved" via its callback (it wrote
// .quire-unresolved but didn't crash), so the callback remains the authoritative outcome
// signal for resolved/unresolved. This only shortcuts the resolutionPoll.ts timeout fallback
// for the case where the callback step never ran at all.
async function handleWorkflowRunEvent(
	event: WorkflowRunEvent,
	selectedRepo: { owner: string; name: string } | undefined,
	queue: MergeQueue,
	conflictLogPath: string,
): Promise<{ ignored: true } | { acknowledged: true }> {
	if (
		event.status !== "completed" ||
		event.conclusion === "success" ||
		selectedRepo === undefined ||
		selectedRepo.owner !== event.repoOwner ||
		selectedRepo.name !== event.repoName
	) {
		return { ignored: true };
	}

	const entry = await queue.findResolvingByWorkflowRun(event.repoOwner, event.repoName, event.workflowRunId);
	if (entry === undefined || entry.resolution === undefined) return { ignored: true };

	const reason = `conflict-resolution workflow run concluded: ${event.conclusion ?? "unknown"}`;
	const failed = await queue.markResolutionFailed(entry.bundleId, entry.resolution.prId, reason);
	// undefined means something else (the Action's own callback, most likely) already moved
	// this entry out of "resolving" between the lookup above and this call — nothing to log.
	if (failed === undefined) return { ignored: true };

	await logConflictResolution(conflictLogPath, entry.bundleId, entry.resolution.prId, "unresolved", reason);
	return { acknowledged: true };
}

// Mounted at /webhooks/github, guarded by verifyGithubSignature (HMAC, not localOnly — see
// that middleware's comment) and a raw-body parser (see index.ts wiring). Not registered at
// all unless a webhook secret is configured.
//
// findTenant resolves the tenant that owns the delivery's installation — a single GitHub
// App receives every tenant's webhook deliveries (both pull_request and workflow_run) on
// this one endpoint, so there is no longer one shared RefreshDeps/MergeQueue to fall back
// on (see TenantRegistry.findByInstallationId).
export function webhookRouter(findTenant: (installationId: number) => WebhookTenant | undefined): Router {
	const router = Router();

	router.post("/", (req, res, next) => {
		const event = req.get("x-github-event");
		if (event === "ping") {
			res.status(200).json({ pong: true });
			return;
		}
		if (event !== "pull_request" && event !== "workflow_run") {
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

		if (event === "workflow_run") {
			const parsedRun = parseWorkflowRunEvent(payload);
			const tenant = parsedRun?.installationId !== undefined ? findTenant(parsedRun.installationId) : undefined;
			if (parsedRun === undefined || tenant === undefined) {
				res.status(200).json({ ignored: true });
				return;
			}
			handleWorkflowRunEvent(parsedRun, tenant.refreshDeps.accountState.current?.selectedRepo, tenant.queue, tenant.conflictLogPath)
				.then((result) => res.status(200).json(result))
				.catch(next);
			return;
		}

		const parsed = parsePullRequestEvent(payload);
		const tenant = parsed?.installationId !== undefined ? findTenant(parsed.installationId) : undefined;
		const refreshDeps = tenant?.refreshDeps;
		const selected = refreshDeps?.accountState.current?.selectedRepo;
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
