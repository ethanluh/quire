import express from "express";
import { Octokit } from "@octokit/rest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAuditStore } from "../../engine/gate/auditStore.js";
import { MergeQueue } from "../../engine/queue/mergeQueue.js";
import { DecidedPrStore } from "../../engine/queue/decidedPrStore.js";
import type { GitHubClient } from "../../engine/github/client.js";
import { StubGitHubClient } from "../../engine/github/stubClient.js";
import { OctokitGitHubClient } from "../../engine/github/octokitClient.js";
import { GitHubClientHolder } from "../../engine/github/clientHolder.js";
import { loadAccount } from "../../engine/github/account.js";
import { fetchAuthenticatedUser } from "../../engine/github/verifyToken.js";
import { listRepositories } from "../../engine/github/repos.js";
import { resolveLlmProvider } from "./resolveLlmProvider.js";
import { buildAuthorizeUrl, exchangeCodeForToken, refreshAccessToken } from "../../engine/github/oauth.js";
import type { OAuthDeps } from "../../engine/github/oauth.js";
import { NeedsReconnectError } from "../../engine/github/tokenRefresh.js";
import { TypeScriptAnalyzer } from "../../engine/drift/footprint/typescript.js";
import { createServerState } from "./state.js";
import { createAccountState } from "./accountState.js";
import { enqueueRefresh } from "./refreshRepoQueue.js";
import type { RefreshDeps } from "./refreshRepoQueue.js";
import { prsRouter } from "./routes/prs.js";
import { bundlesRouter } from "./routes/bundles.js";
import { gesturesRouter } from "./routes/gestures.js";
import { queueRouter } from "./routes/queue.js";
import { shelfRouter } from "./routes/shelf.js";
import { auditRouter } from "./routes/audit.js";
import { adminRouter } from "./routes/admin.js";
import { githubAccountRouter } from "./routes/account.js";
import type { WebhookConfig } from "./routes/account.js";
import { webhookRouter } from "./routes/webhook.js";
import { verifyGithubSignature } from "./middleware/webhookSignature.js";
import { errorHandler } from "./middleware/errors.js";
import { createNdjsonInstrumentationSink } from "../../engine/instrumentation/logger.js";
import type { PipelineConfig } from "../../engine/pipeline/pipeline.js";
import type { PipelineDeps } from "./ingestIntoQueue.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "../../../data");
const QUEUE_PATH = join(DATA_DIR, "queue.json");
const DECIDED_PRS_PATH = join(DATA_DIR, "decided-prs.json");
const DEFER_LOG_PATH = join(DATA_DIR, "instrumentation/defers.ndjson");
const GATE_LOG_PATH = join(DATA_DIR, "instrumentation/gate-decisions.ndjson");
const DRIFT_SCREEN_LOG_PATH = join(DATA_DIR, "instrumentation/drift-screen.ndjson");
const AUDIT_LOG_PATH = join(DATA_DIR, "instrumentation/audit.ndjson");
const ACCOUNT_PATH = join(DATA_DIR, "github-account.json");

const PORT = parseInt(process.env["PORT"] ?? "3000", 10);
const RECONCILE_INTERVAL_MS =
	parseInt(process.env["QUIRE_RECONCILE_INTERVAL_MINUTES"] ?? "20", 10) * 60 * 1000;

const pipelineConfig: PipelineConfig = {
	gate: {
		criteria: [
			{ name: "buildFailure", mode: "enforce" },
			{ name: "outOfScope", mode: "off" },
			{ name: "duplicate", mode: "shadow" },
		],
	},
	bundle: { similarityThreshold: 0.75 },
};

async function main(): Promise<void> {
	const app = express();

	const githubToken = process.env["GITHUB_TOKEN"];
	const webhookSecret = process.env["GITHUB_WEBHOOK_SECRET"];
	const publicUrl = process.env["QUIRE_PUBLIC_URL"];
	const webhookConfig: WebhookConfig | undefined =
		webhookSecret !== undefined && webhookSecret !== "" && publicUrl !== undefined && publicUrl !== ""
			? { publicUrl, secret: webhookSecret }
			: undefined;

	const auditStore = await loadAuditStore(AUDIT_LOG_PATH);
	const connectedAccount = await loadAccount(ACCOUNT_PATH);
	const accountState = createAccountState(connectedAccount);

	const decidedStore = new DecidedPrStore(DECIDED_PRS_PATH);
	await decidedStore.load();

	const oauthClientId = process.env["GITHUB_OAUTH_CLIENT_ID"];
	const oauthClientSecret = process.env["GITHUB_OAUTH_CLIENT_SECRET"];
	let oauthDeps: OAuthDeps | undefined;
	if (oauthClientId !== undefined && oauthClientId !== "" && oauthClientSecret !== undefined && oauthClientSecret !== "") {
		const redirectUri = `http://localhost:${PORT}/account/github/oauth/callback`;
		oauthDeps = {
			config: { clientId: oauthClientId, clientSecret: oauthClientSecret },
			buildAuthorizeUrl,
			exchangeCodeForToken,
			refreshAccessToken,
			redirectUri,
		};
		console.log(`GitHub OAuth: enabled (callback URL must be registered as ${redirectUri})`);
	} else {
		console.log("GitHub OAuth: disabled (GITHUB_OAUTH_CLIENT_ID/GITHUB_OAUTH_CLIENT_SECRET not set)");
	}

	// A connected account (set up through the UI) takes priority over GITHUB_TOKEN,
	// since it's the more recent, more deliberate choice of credential.
	let initialClient: GitHubClient;
	if (connectedAccount !== undefined) {
		initialClient = new OctokitGitHubClient(new Octokit({ auth: connectedAccount.token }));
		console.log(`GitHub client: octokit (connected as ${connectedAccount.login})`);
	} else if (githubToken !== undefined && githubToken !== "") {
		initialClient = new OctokitGitHubClient(new Octokit({ auth: githubToken }));
		console.log("GitHub client: octokit (GITHUB_TOKEN set)");
	} else {
		initialClient = new StubGitHubClient();
		console.log("GitHub client: stub (no connected account, GITHUB_TOKEN not set)");
	}
	const github = new GitHubClientHolder(initialClient);
	const queue = new MergeQueue(QUEUE_PATH, github);
	await queue.load();

	const { provider, description } = resolveLlmProvider(process.env);
	console.log(`LLM provider: ${description}`);
	const analyzer = new TypeScriptAnalyzer();
	const state = createServerState();
	const instrumentationSink = createNdjsonInstrumentationSink({
		gateLogPath: GATE_LOG_PATH,
		driftScreenLogPath: DRIFT_SCREEN_LOG_PATH,
	});
	const pipelineDeps: PipelineDeps = {
		config: pipelineConfig,
		provider,
		analyzer,
		auditStore,
		instrumentationSink,
	};

	const refreshDeps: RefreshDeps = {
		accountState,
		accountPath: ACCOUNT_PATH,
		clientHolder: github,
		oauth: oauthDeps,
		decidedStore,
		state,
		pipelineDeps,
	};

	// The webhook path needs its exact raw request bytes to verify GitHub's HMAC signature,
	// so it must be parsed (and mounted) before the global express.json() below would
	// otherwise consume the body as parsed JSON.
	if (webhookConfig !== undefined) {
		app.use(
			"/webhooks/github",
			express.raw({ type: "application/json" }),
			verifyGithubSignature(webhookConfig.secret),
			webhookRouter(refreshDeps),
		);
		console.log("GitHub webhook receiver: enabled at /webhooks/github");
	} else {
		console.log("GitHub webhook receiver: disabled (QUIRE_PUBLIC_URL/GITHUB_WEBHOOK_SECRET not set)");
	}

	app.use(express.json());

	// Serve static UI
	app.use(express.static(join(__dirname, "../ui")));

	app.use("/prs", prsRouter(state, pipelineDeps, queue));
	app.use("/bundles", bundlesRouter(state));
	app.use("/bundles", gesturesRouter(state, queue, DEFER_LOG_PATH, github, decidedStore));
	app.use("/queue", queueRouter(queue));
	app.use("/shelf", shelfRouter(state, decidedStore));
	app.use("/audit", auditRouter(auditStore));
	app.use(
		"/admin",
		adminRouter(state, auditStore, queue, [DEFER_LOG_PATH, GATE_LOG_PATH, DRIFT_SCREEN_LOG_PATH]),
	);
	app.use(
		"/account/github",
		githubAccountRouter(
			refreshDeps,
			githubToken,
			fetchAuthenticatedUser,
			(token) => listRepositories(new Octokit({ auth: token })),
			webhookConfig,
		),
	);

	app.use(errorHandler);

	// Independent of webhooks — a safety net for a missed delivery, and the sole detection
	// mechanism if webhooks aren't configured. Shares enqueueRefresh's per-repo coalescing
	// lock with the webhook route, so the two never race on the same repo's queue.
	const reconcileTimer = setInterval(() => {
		const repo = accountState.current?.selectedRepo;
		if (repo === undefined) return;
		enqueueRefresh(repo.owner, repo.name, refreshDeps).catch((err: unknown) => {
			if (err instanceof NeedsReconnectError) {
				console.warn(`Reconciliation poll paused for ${repo.owner}/${repo.name}: ${err.message}`);
				return;
			}
			console.error(`Reconciliation poll failed for ${repo.owner}/${repo.name}:`, err);
		});
	}, RECONCILE_INTERVAL_MS);
	reconcileTimer.unref();

	app.listen(PORT, () => {
		console.log(`Quire running on http://localhost:${PORT}`);
	});
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
