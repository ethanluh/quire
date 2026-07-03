import { Router } from "express";
import type { RefreshDeps } from "../refreshRepoQueue.js";
import { enqueueRefresh, AccountChangedError } from "../refreshRepoQueue.js";
import type { MergeQueue } from "../../../engine/queue/mergeQueue.js";
import { logConflictResolution } from "../../../engine/instrumentation/logger.js";

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

	return { action, repoOwner: ownerLogin, repoName, pullRequestId: String(prId) };
}

interface WorkflowRunEvent {
	status: string;
	conclusion: string | undefined;
	workflowRunId: number;
	repoOwner: string;
	repoName: string;
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

	return {
		workflowRunId: id,
		status,
		conclusion: conclusion ?? undefined,
		repoOwner: ownerLogin,
		repoName,
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
export function webhookRouter(refreshDeps: RefreshDeps, queue: MergeQueue, conflictLogPath: string): Router {
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
			if (parsedRun === undefined) {
				res.status(200).json({ ignored: true });
				return;
			}
			handleWorkflowRunEvent(parsedRun, refreshDeps.accountState.current?.selectedRepo, queue, conflictLogPath)
				.then((result) => res.status(200).json(result))
				.catch(next);
			return;
		}

		const parsed = parsePullRequestEvent(payload);
		const selected = refreshDeps.accountState.current?.selectedRepo;
		if (
			parsed === undefined ||
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
