import { randomBytes } from "node:crypto";
import express from "express";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAuditStore } from "../../engine/gate/auditStore.js";
import { MergeQueue } from "../../engine/queue/mergeQueue.js";
import { DecidedPrStore } from "../../engine/queue/decidedPrStore.js";
import { PrEffectCache } from "../../engine/cache/prCache.js";
import type { GitHubClient } from "../../engine/github/client.js";
import { StubGitHubClient } from "../../engine/github/stubClient.js";
import { GitHubClientHolder } from "../../engine/github/clientHolder.js";
import { loadInstallation } from "../../engine/github/installation.js";
import { createUserTokenCache } from "../../engine/github/userTokenCache.js";
import { buildInstallationClient, buildInstallationOctokit, buildUserOctokit, getInstallationAccount } from "../../engine/github/installationClient.js";
import type { GitHubAppConfig } from "../../engine/github/installationClient.js";
import { InstallationRevokedError } from "../../engine/github/installationClient.js";
import { fetchAuthenticatedUser } from "../../engine/github/verifyToken.js";
import { listInstallationRepositories, enrichWithStarredAndPinned } from "../../engine/github/repos.js";
import { resolveLlmProvider, buildLlmProviderFromAccount } from "./resolveLlmProvider.js";
import { LlmProviderHolder } from "../../engine/drift/effectList/providerHolder.js";
import { loadAccount as loadLlmAccount } from "../../engine/llm/account.js";
import { createLlmAccountState } from "./llmAccountState.js";
import { llmAccountRouter } from "./routes/llmAccount.js";
import { buildAuthorizeUrl, exchangeCodeForToken, refreshAccessToken } from "../../engine/github/oauth.js";
import type { OAuthDeps } from "../../engine/github/oauth.js";
import { TypeScriptAnalyzer } from "../../engine/drift/footprint/typescript.js";
import { createServerState } from "./state.js";
import { createAccountState, activeInstallation } from "./accountState.js";
import { enqueueRefresh, AccountChangedError } from "./refreshRepoQueue.js";
import type { RefreshDeps } from "./refreshRepoQueue.js";
import { createAllowlist } from "./allowlist.js";
import { requireSession } from "./middleware/requireSession.js";
import { prsRouter } from "./routes/prs.js";
import { bundlesRouter } from "./routes/bundles.js";
import { gesturesRouter } from "./routes/gestures.js";
import { queueRouter } from "./routes/queue.js";
import { shelfRouter } from "./routes/shelf.js";
import { eventsRouter } from "./routes/events.js";
import { auditRouter } from "./routes/audit.js";
import { adminRouter } from "./routes/admin.js";
import { accountRouter } from "./routes/account.js";
import { githubAppRouter } from "./routes/githubApp.js";
import type { WebhookConfig } from "./routes/webhook.js";
import { webhookRouter } from "./routes/webhook.js";
import { verifyGithubSignature } from "./middleware/webhookSignature.js";
import { errorHandler } from "./middleware/errors.js";
import { createNdjsonInstrumentationSink } from "../../engine/instrumentation/logger.js";
import type { PipelineConfig } from "../../engine/pipeline/pipeline.js";
import type { PipelineDeps } from "./ingestIntoQueue.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Not derived from __dirname: the compiled dist/ output nests one level deeper than the
// source (dist/src/interface/server vs. src/interface/server), so a fixed "../../../data"
// walk lands in the wrong place in production. process.cwd() is stable across `npm run dev`
// and `npm start` (both invoked from the project root); QUIRE_DATA_DIR lets a deploy mount
// its persistent volume anywhere.
const DATA_DIR = process.env.QUIRE_DATA_DIR ?? join(process.cwd(), "data");
const QUEUE_PATH = join(DATA_DIR, "queue.json");
const DECIDED_PRS_PATH = join(DATA_DIR, "decided-prs.json");
const PR_CACHE_PATH = join(DATA_DIR, "pr-cache.json");
const DEFER_LOG_PATH = join(DATA_DIR, "instrumentation/defers.ndjson");
const GATE_LOG_PATH = join(DATA_DIR, "instrumentation/gate-decisions.ndjson");
const DRIFT_SCREEN_LOG_PATH = join(DATA_DIR, "instrumentation/drift-screen.ndjson");
const CONFLICT_LOG_PATH = join(DATA_DIR, "instrumentation/conflict-resolution.ndjson");
const AUDIT_LOG_PATH = join(DATA_DIR, "instrumentation/audit.ndjson");
const INSTALLATION_PATH = join(DATA_DIR, "installation.json");
const LLM_ACCOUNT_PATH = join(DATA_DIR, "llm-account.json");

const PORT = parseInt(process.env["PORT"] ?? "3000", 10);
const RECONCILE_INTERVAL_MS =
	parseInt(process.env["QUIRE_RECONCILE_INTERVAL_MINUTES"] ?? "20", 10) * 60 * 1000;
const QUEUE_REFRESH_INTERVAL_MS =
	parseInt(process.env["QUIRE_QUEUE_REFRESH_INTERVAL_MINUTES"] ?? "5", 10) * 60 * 1000;

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

function requireEnv(name: string): string {
	const value = process.env[name];
	if (value === undefined || value === "") {
		throw new Error(
			`Missing required environment variable ${name}. Quire's GitHub integration is a GitHub App now — ` +
				"see .env.example and README.md's GitHub App setup section for how to register one and fill these in.",
		);
	}
	return value;
}

async function main(): Promise<void> {
	const app = express();

	// `KEY=` (present but empty) in a .env file sets process.env.KEY to "", not undefined —
	// normalize that to undefined here so every fallback below (`??`) actually triggers.
	const rawPublicUrl = process.env["QUIRE_PUBLIC_URL"];
	const publicUrl = rawPublicUrl !== undefined && rawPublicUrl !== "" ? rawPublicUrl : undefined;
	const isProduction = publicUrl !== undefined && publicUrl.startsWith("https://");

	let sessionSecret = process.env["QUIRE_SESSION_SECRET"];
	if (sessionSecret === undefined || sessionSecret === "") {
		sessionSecret = randomBytes(32).toString("hex");
		console.warn(
			"QUIRE_SESSION_SECRET not set — generated a random one for this process. " +
				"Every existing session will be invalidated on restart. Set it explicitly once hosted " +
				"(e.g. `openssl rand -hex 32`).",
		);
	}
	const allowedLogins = process.env["QUIRE_ALLOWED_GITHUB_LOGINS"];
	const allowlist = createAllowlist(allowedLogins);
	if (allowedLogins === undefined || allowedLogins === "") {
		console.warn("QUIRE_ALLOWED_GITHUB_LOGINS not set — any GitHub account can sign in. Set this before hosting.");
	}

	const appConfig: GitHubAppConfig = {
		appId: requireEnv("GITHUB_APP_ID"),
		privateKey: Buffer.from(requireEnv("GITHUB_APP_PRIVATE_KEY_BASE64"), "base64").toString("utf8"),
	};
	const appSlug = requireEnv("GITHUB_APP_SLUG");
	const oauthDeps: OAuthDeps = {
		config: { clientId: requireEnv("GITHUB_APP_CLIENT_ID"), clientSecret: requireEnv("GITHUB_APP_CLIENT_SECRET") },
		buildAuthorizeUrl,
		exchangeCodeForToken,
		refreshAccessToken,
		redirectUri: `${publicUrl ?? `http://localhost:${PORT}`}/account/github/oauth/callback`,
	};

	const webhookSecret = process.env["GITHUB_APP_WEBHOOK_SECRET"];
	const webhookConfig: WebhookConfig | undefined =
		webhookSecret !== undefined && webhookSecret !== "" && publicUrl !== undefined
			? { publicUrl, secret: webhookSecret }
			: undefined;

	const auditStore = await loadAuditStore(AUDIT_LOG_PATH);
	const installationAccountState = await loadInstallation(INSTALLATION_PATH);
	const accountState = createAccountState(installationAccountState);
	const userTokenCache = createUserTokenCache();

	const decidedStore = new DecidedPrStore(DECIDED_PRS_PATH);
	await decidedStore.load();

	const prCache = new PrEffectCache(PR_CACHE_PATH);
	await prCache.load();

	let initialClient: GitHubClient;
	const active = activeInstallation(accountState.current);
	if (active !== undefined) {
		initialClient = buildInstallationClient(appConfig, active.installationId);
		console.log(`GitHub client: installation (bound to ${active.accountLogin}, ${accountState.current.installations.length} installation(s) total)`);
	} else {
		initialClient = new StubGitHubClient();
		console.log(`GitHub client: stub (${accountState.current.installations.length} installation(s) bound, none backing a selected repo)`);
	}
	const github = new GitHubClientHolder(initialClient);

	// An LLM account connected through the UI takes priority over env-based resolution.
	// Resolved before MergeQueue below, which needs a provider for conflict resolution.
	const connectedLlmAccount = await loadLlmAccount(LLM_ACCOUNT_PATH);
	const llmAccountState = createLlmAccountState(connectedLlmAccount);
	const { provider: initialLlmProvider, description } =
		connectedLlmAccount !== undefined ? buildLlmProviderFromAccount(connectedLlmAccount) : resolveLlmProvider(process.env);
	console.log(`LLM provider: ${description}`);
	const llmProviderHolder = new LlmProviderHolder(initialLlmProvider);

	const queue = new MergeQueue(QUEUE_PATH, github, llmProviderHolder, CONFLICT_LOG_PATH);
	await queue.load();

	const analyzer = new TypeScriptAnalyzer();
	const state = createServerState();
	const instrumentationSink = createNdjsonInstrumentationSink({
		gateLogPath: GATE_LOG_PATH,
		driftScreenLogPath: DRIFT_SCREEN_LOG_PATH,
	});
	const pipelineDeps: PipelineDeps = {
		config: pipelineConfig,
		provider: llmProviderHolder,
		analyzer,
		auditStore,
		prCache,
		instrumentationSink,
	};

	const refreshDeps: RefreshDeps = {
		accountState,
		accountPath: INSTALLATION_PATH,
		clientHolder: github,
		appConfig,
		decidedStore,
		state,
		pipelineDeps,
	};

	// The webhook path needs its exact raw request bytes to verify GitHub's HMAC signature,
	// so it must be parsed (and mounted) before the global express.json() below would
	// otherwise consume the body as parsed JSON. Its own signature check is the trust
	// boundary here, independent of session auth (GitHub's delivery carries no cookie).
	if (webhookConfig !== undefined) {
		app.use(
			"/webhooks/github",
			express.raw({ type: "application/json" }),
			verifyGithubSignature(webhookConfig.secret),
			webhookRouter(refreshDeps),
		);
		console.log("GitHub webhook receiver: enabled at /webhooks/github");
	} else {
		console.log("GitHub webhook receiver: disabled (QUIRE_PUBLIC_URL/GITHUB_APP_WEBHOOK_SECRET not set)");
	}

	app.use(express.json());

	// Serve static UI — public; the login gate is enforced by the API, not page delivery,
	// so the frontend can always load and show an appropriate signed-in/signed-out state.
	app.use(express.static(join(__dirname, "../ui")));

	const session = requireSession(sessionSecret, allowlist, isProduction);

	// Login-establishing routes: reachable without a session (that's the point). Mounted
	// before the global `session` middleware below applies to everything else.
	app.use(
		"/account/github",
		accountRouter(oauthDeps, fetchAuthenticatedUser, allowlist, sessionSecret, isProduction, session, userTokenCache),
	);

	app.use(session);

	app.use(
		"/account/github",
		githubAppRouter(
			refreshDeps,
			appSlug,
			(installationId) => buildInstallationClient(appConfig, installationId),
			(installationId, accountLogin) =>
				listInstallationRepositories(buildInstallationOctokit(appConfig, installationId), installationId, accountLogin),
			(installationId) => getInstallationAccount(appConfig, installationId),
			isProduction,
			userTokenCache,
			(repos, accessToken) => enrichWithStarredAndPinned(repos, buildUserOctokit(accessToken)),
		),
	);
	app.use("/prs", prsRouter(state, pipelineDeps, queue));
	app.use("/bundles", bundlesRouter(state));
	app.use("/bundles", gesturesRouter(state, queue, DEFER_LOG_PATH, github, decidedStore, accountState));
	app.use("/queue", queueRouter(queue, state, decidedStore));
	app.use("/shelf", shelfRouter(state, decidedStore));
	app.use("/events", eventsRouter());
	app.use("/audit", auditRouter(auditStore));
	app.use(
		"/admin",
		adminRouter(
			state,
			auditStore,
			queue,
			[DEFER_LOG_PATH, GATE_LOG_PATH, DRIFT_SCREEN_LOG_PATH, CONFLICT_LOG_PATH],
			decidedStore,
		),
	);
	app.use(
		"/account/llm",
		llmAccountRouter(
			llmAccountState,
			LLM_ACCOUNT_PATH,
			llmProviderHolder,
			buildLlmProviderFromAccount,
			() => resolveLlmProvider(process.env),
		),
	);

	app.use(errorHandler);

	// Independent of webhooks — a safety net for a missed delivery, and the sole detection
	// mechanism if webhooks aren't configured. Shares enqueueRefresh's per-repo coalescing
	// lock with the webhook route, so the two never race on the same repo's queue.
	const reconcileTimer = setInterval(() => {
		const repo = accountState.current.selectedRepo;
		if (repo === undefined) return;
		enqueueRefresh(repo.owner, repo.name, refreshDeps).catch((err: unknown) => {
			if (err instanceof InstallationRevokedError) {
				console.warn(`Reconciliation poll paused for ${repo.owner}/${repo.name}: ${err.message}`);
				return;
			}
			if (err instanceof AccountChangedError) {
				console.warn(`Reconciliation poll for ${repo.owner}/${repo.name} aborted: ${err.message}`);
				return;
			}
			console.error(`Reconciliation poll failed for ${repo.owner}/${repo.name}:`, err);
		});
	}, RECONCILE_INTERVAL_MS);
	reconcileTimer.unref();

	// Keeps queued PRs from drifting far behind main while they wait their turn — a bundle
	// stuck behind several others that land ahead of it would otherwise only get checked (and
	// fast-forwarded) once dequeueNext() finally reaches it, by which point "behind" may have
	// calcified into a real "dirty" conflict needing the in-process hunk resolver instead of a
	// free merge.
	const queueRefreshTimer = setInterval(() => {
		queue.refreshQueuedBranches().catch((err: unknown) => {
			console.error("Queue branch refresh failed:", err);
		});
	}, QUEUE_REFRESH_INTERVAL_MS);
	queueRefreshTimer.unref();

	app.listen(PORT, () => {
		console.log(`Quire running on http://localhost:${PORT}`);
	});
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
