import { randomBytes } from "node:crypto";
import express from "express";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { GitHubAppConfig } from "../../engine/github/installationClient.js";
import { InstallationRevokedError, buildUserOctokit } from "../../engine/github/installationClient.js";
import { fetchAuthenticatedUser } from "../../engine/github/verifyToken.js";
import { createUserTokenCache } from "../../engine/github/userTokenCache.js";
import { enrichWithStarredAndPinned } from "../../engine/github/repos.js";
import type { RepoSummary } from "../../engine/github/repos.js";
import { resolveLlmProvider } from "./resolveLlmProvider.js";
import { buildAuthorizeUrl, exchangeCodeForToken, refreshAccessToken } from "../../engine/github/oauth.js";
import type { OAuthDeps } from "../../engine/github/oauth.js";
import { TypeScriptAnalyzer } from "../../engine/drift/footprint/typescript.js";
import { TenantRegistry } from "./tenant.js";
import type { TenantSharedConfig } from "./tenant.js";
import { enqueueRefresh, AccountChangedError } from "./refreshRepoQueue.js";
import { createAllowlist } from "./allowlist.js";
import { requireSession } from "./middleware/requireSession.js";
import { resolveTenant } from "./middleware/resolveTenant.js";
import { eventsRouter } from "./routes/events.js";
import { accountRouter } from "./routes/account.js";
import type { WebhookConfig } from "./routes/webhook.js";
import { webhookRouter } from "./routes/webhook.js";
import { verifyGithubSignature } from "./middleware/webhookSignature.js";
import { errorHandler } from "./middleware/errors.js";
import type { PipelineConfig } from "../../engine/pipeline/pipeline.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Not derived from __dirname: the compiled dist/ output nests one level deeper than the
// source (dist/src/interface/server vs. src/interface/server), so a fixed "../../../data"
// walk lands in the wrong place in production. process.cwd() is stable across `npm run dev`
// and `npm start` (both invoked from the project root); QUIRE_DATA_DIR lets a deploy mount
// its persistent volume anywhere.
const DATA_DIR = process.env.QUIRE_DATA_DIR ?? join(process.cwd(), "data");

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

	// Fails fast on a bad LLM_PROVIDER/key combination at startup instead of on whichever
	// tenant's first request happens to hit resolveDefaultLlmProvider() first.
	const { description: defaultLlmDescription } = resolveLlmProvider(process.env);
	console.log(`Default LLM provider (used by a tenant until they connect their own): ${defaultLlmDescription}`);

	// A signed-in user's own OAuth token, cached in memory only, keyed by login — used
	// solely to enrich the repo picker with starred/pinned status (an installation client
	// has no "viewer" of its own). Already partitioned by login internally, so — unlike
	// accountState/clientHolder/queue below — it's safe to share across tenants: every
	// caller only ever looks up the current request's own login.
	const userTokenCache = createUserTokenCache();
	const enrichWithUserToken = (repos: ReadonlyArray<RepoSummary>, accessToken: string) =>
		enrichWithStarredAndPinned(repos, buildUserOctokit(accessToken));

	const sharedConfig: TenantSharedConfig = {
		dataDir: DATA_DIR,
		appConfig,
		appSlug,
		pipelineConfig,
		analyzer: new TypeScriptAnalyzer(),
		isProduction,
		resolveDefaultLlmProvider: () => resolveLlmProvider(process.env),
		userTokenCache,
		enrichWithUserToken,
	};

	// Every signed-in GitHub login gets its own isolated GitHub App installation, repo
	// selection, PR queue, and LLM account (see tenant.ts) — replaces the single set of
	// process-wide singletons a prior version of this file wired up once and shared across
	// every request regardless of who was signed in.
	const registry = new TenantRegistry(sharedConfig);
	await registry.hydrateExisting();
	console.log(`Loaded ${registry.all().length} existing tenant(s) from ${join(DATA_DIR, "users")}`);

	// The webhook path needs its exact raw request bytes to verify GitHub's HMAC signature,
	// so it must be parsed (and mounted) before the global express.json() below would
	// otherwise consume the body as parsed JSON. Its own signature check is the trust
	// boundary here, independent of session auth (GitHub's delivery carries no cookie).
	// One App, one webhook endpoint, many tenants' installations — each delivery is routed
	// to its owning tenant by the installation id it carries (see webhookRouter).
	if (webhookConfig !== undefined) {
		app.use(
			"/webhooks/github",
			express.raw({ type: "application/json" }),
			verifyGithubSignature(webhookConfig.secret),
			webhookRouter((installationId) => registry.findByInstallationId(installationId)?.refreshDeps),
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
	app.use(resolveTenant(registry));

	// Shared across every tenant on purpose: it carries no payload, just a "something
	// changed, go re-fetch" wakeup (see changeEvents.ts), so there's no cross-tenant data
	// leak in mounting one instance here instead of one per tenant router. See the
	// known-gap note on notifyStateChanged()/changeEvents.ts below — this does mean one
	// tenant's refresh currently wakes every open /events connection, tenant or not.
	app.use("/events", eventsRouter());

	// Every other route lives on the resolved tenant's own router (built once per tenant in
	// tenant.ts from the exact same route factories this file used to wire up a single time
	// at startup) — dispatching here instead of mounting one shared router per path is what
	// keeps one signed-in login from ever reaching another's state.
	app.use((req, res, next) => {
		const tenant = res.locals.tenant;
		if (tenant === undefined) {
			res.status(401).json({ error: "Sign in required" });
			return;
		}
		tenant.router(req, res, next);
	});

	app.use(errorHandler);

	// Independent of webhooks — a safety net for a missed delivery, and the sole detection
	// mechanism if webhooks aren't configured. Iterates every known tenant (not just the
	// ones actively browsing) so a teammate's repo stays in sync even while they're away.
	const reconcileTimer = setInterval(() => {
		for (const tenant of registry.all()) {
			const repo = tenant.accountState.current?.selectedRepo;
			if (repo === undefined) continue;
			enqueueRefresh(repo.owner, repo.name, tenant.refreshDeps).catch((err: unknown) => {
				if (err instanceof InstallationRevokedError) {
					console.warn(`Reconciliation poll paused for ${tenant.login} (${repo.owner}/${repo.name}): ${err.message}`);
					return;
				}
				if (err instanceof AccountChangedError) {
					console.warn(`Reconciliation poll for ${tenant.login} (${repo.owner}/${repo.name}) aborted: ${err.message}`);
					return;
				}
				console.error(`Reconciliation poll failed for ${tenant.login} (${repo.owner}/${repo.name}):`, err);
			});
		}
	}, RECONCILE_INTERVAL_MS);
	reconcileTimer.unref();

	// Keeps queued PRs from drifting far behind main while they wait their turn — a bundle
	// stuck behind several others that land ahead of it would otherwise only get checked (and
	// fast-forwarded) once dequeueNext() finally reaches it, by which point "behind" may have
	// calcified into a real "dirty" conflict needing the in-process hunk resolver instead of a
	// free merge. Iterates every known tenant's own queue, same as the reconcile timer above.
	const queueRefreshTimer = setInterval(() => {
		for (const tenant of registry.all()) {
			tenant.queue.refreshQueuedBranches().catch((err: unknown) => {
				console.error(`Queue branch refresh failed for ${tenant.login}:`, err);
			});
		}
	}, QUEUE_REFRESH_INTERVAL_MS);
	queueRefreshTimer.unref();

	// Checks in on any in-flight Managed Agents deep-investigation sessions (opt-in — see
	// tenant.ts's DeepInvestigationDeps). A no-op for tenants who never started one:
	// pollInvestigations() only touches "investigating" entries. Reuses the same cadence as
	// the queue-branch refresh above rather than introducing a third interval knob.
	const investigationPollTimer = setInterval(() => {
		for (const tenant of registry.all()) {
			tenant.queue.pollInvestigations().catch((err: unknown) => {
				console.error(`Deep conflict investigation poll failed for ${tenant.login}:`, err);
			});
		}
	}, QUEUE_REFRESH_INTERVAL_MS);
	investigationPollTimer.unref();

	app.listen(PORT, () => {
		console.log(`Quire running on http://localhost:${PORT}`);
	});
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
