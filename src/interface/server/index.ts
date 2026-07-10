import express from "express";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { GitHubAppConfig } from "../../engine/github/installationClient.js";
import { InstallationRevokedError, buildInstallationOctokit, buildUserOctokit } from "../../engine/github/installationClient.js";
import { fetchAuthenticatedUser } from "../../engine/github/verifyToken.js";
import { createUserTokenCache } from "../../engine/github/userTokenCache.js";
import { enrichWithStarredAndPinned, filterReposAccessibleToUser, isRepoAccessibleToUser } from "../../engine/github/repos.js";
import type { RepoSummary } from "../../engine/github/repos.js";
import { resolveLlmProvider } from "./resolveLlmProvider.js";
import { resolveSessionSecret } from "./sessionSecret.js";
import { buildAuthorizeUrl, exchangeCodeForToken, refreshAccessToken } from "../../engine/github/oauth.js";
import type { OAuthDeps } from "../../engine/github/oauth.js";
import { TypeScriptAnalyzer } from "../../engine/drift/footprint/typescript.js";
import { TenantRegistry } from "./tenant.js";
import type { TenantSharedConfig } from "./tenant.js";
import { enqueueRefresh, AccountChangedError } from "./refreshRepoQueue.js";
import { createAllowlist } from "./allowlist.js";
import { requireSession } from "./middleware/requireSession.js";
import { resolveMembership } from "./middleware/resolveMembership.js";
import { resolveTenant } from "./middleware/resolveTenant.js";
import { eventsRouter } from "./routes/events.js";
import { accountRouter } from "./routes/account.js";
import { teamRouter } from "./routes/team.js";
import { migrateLegacyData } from "./migrateLegacyData.js";
import { TeamStore } from "../../engine/team/teamStore.js";
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

	// Baseline security headers on every response. Not a full CSP (the current UI leans on
	// inline event handlers, which a strict script-src would break) — but nosniff, a deny
	// frame policy, and a tight referrer policy are free defense-in-depth: they blunt MIME
	// confusion, clickjacking, and referrer-based token/path leakage regardless of the CSP gap.
	app.use((_req, res, next) => {
		res.setHeader("X-Content-Type-Options", "nosniff");
		res.setHeader("X-Frame-Options", "DENY");
		res.setHeader("Referrer-Policy", "no-referrer");
		next();
	});

	// `KEY=` (present but empty) in a .env file sets process.env.KEY to "", not undefined —
	// normalize that to undefined here so every fallback below (`??`) actually triggers.
	const rawPublicUrl = process.env["QUIRE_PUBLIC_URL"];
	const publicUrl = rawPublicUrl !== undefined && rawPublicUrl !== "" ? rawPublicUrl : undefined;
	const isProduction = publicUrl !== undefined && publicUrl.startsWith("https://");

	// On a real (HTTPS) host these two footguns must fail closed, not just warn — an empty
	// allowlist admits every GitHub account on the internet, and a missing signing secret means
	// the session/invite HMAC key is auto-generated onto the data volume where a backup or
	// volume read can lift it. Both are fine to default permissively for local/dogfood use only.
	const rawSessionSecret = process.env["QUIRE_SESSION_SECRET"];
	if (isProduction && (rawSessionSecret === undefined || rawSessionSecret === "")) {
		throw new Error(
			"QUIRE_SESSION_SECRET must be set when hosting (QUIRE_PUBLIC_URL is https). " +
				"Generate one with `openssl rand -hex 32` and set it in the environment.",
		);
	}
	const sessionSecret = await resolveSessionSecret(DATA_DIR);
	const allowedLogins = process.env["QUIRE_ALLOWED_GITHUB_LOGINS"];
	if (allowedLogins === undefined || allowedLogins === "") {
		if (isProduction) {
			throw new Error(
				"QUIRE_ALLOWED_GITHUB_LOGINS must be set when hosting (QUIRE_PUBLIC_URL is https) — " +
					"an empty allowlist would let any GitHub account sign in. Set a comma-separated login list.",
			);
		}
		console.warn("QUIRE_ALLOWED_GITHUB_LOGINS not set — any GitHub account can sign in. Set this before hosting.");
	}
	const allowlist = createAllowlist(allowedLogins);

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

	// Keyed by login, not team: starred/pinned enrichment needs the signed-in user's own
	// GitHub token, which has nothing to do with which team they're currently on — shared
	// across every tenant's router the same way appConfig/appSlug are (see
	// TenantSharedConfig), populated by accountRouter on sign-in.
	const userTokenCache = createUserTokenCache();
	const enrichWithUserToken = (repos: ReadonlyArray<RepoSummary>, accessToken: string) =>
		enrichWithStarredAndPinned(repos, buildUserOctokit(accessToken));
	const filterReposForUser = (repos: ReadonlyArray<RepoSummary>, accessToken: string) =>
		filterReposAccessibleToUser(repos, buildUserOctokit(accessToken));
	const canUserAccessRepo = (owner: string, name: string, accessToken: string) =>
		isRepoAccessibleToUser(owner, name, buildUserOctokit(accessToken));

	// Constructed before sharedConfig (rather than alongside registry below) so
	// TenantSharedConfig can hand the same instance to every tenant's githubAppRouter —
	// needed there to look up a team's current roster when a repo is unbound (see
	// githubApp.ts's revokeAccessOnUnbind).
	const teamStore = new TeamStore(DATA_DIR);

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
		filterReposForUser,
		canUserAccessRepo,
		oauth: oauthDeps,
		teamStore,
		webhooksEnabled: webhookConfig !== undefined,
	};

	// Every team gets its own isolated GitHub App installation, repo selection, PR queue,
	// and LLM account (see tenant.ts) — replaces the single set of process-wide singletons
	// a prior version of this file wired up once and shared across every request
	// regardless of who was signed in. A login resolves to a team via resolveMembership,
	// mounted ahead of resolveTenant below.
	const registry = new TenantRegistry(sharedConfig);
	await migrateLegacyData(DATA_DIR, teamStore, allowedLogins);
	await registry.hydrateExisting();
	console.log(`Loaded ${registry.all().length} existing team(s) from ${join(DATA_DIR, "teams")}`);

	// The webhook path needs its exact raw request bytes to verify GitHub's HMAC signature,
	// so it must be parsed (and mounted) before the global express.json() below would
	// otherwise consume the body as parsed JSON. Its own signature check is the trust
	// boundary here, independent of session auth (GitHub's delivery carries no cookie).
	// One App, one webhook endpoint, many tenants' installations (each tenant possibly
	// binding several) — each delivery is routed to its owning tenant by the installation id
	// it carries (see webhookRouter and TenantRegistry.findByInstallationId).
	if (webhookConfig !== undefined) {
		app.use(
			"/webhooks/github",
			express.raw({ type: "application/json", limit: "1mb" }),
			verifyGithubSignature(webhookConfig.secret),
			webhookRouter((installationId) => {
				const tenant = registry.findByInstallationId(installationId);
				return tenant !== undefined ? { refreshDeps: tenant.refreshDeps } : undefined;
			}),
		);
		console.log("GitHub webhook receiver: enabled at /webhooks/github");
	} else {
		console.warn(
			"GitHub webhook receiver disabled (set QUIRE_PUBLIC_URL and GITHUB_APP_WEBHOOK_SECRET to enable) — " +
				"PR updates rely on the 60s background refresh and 20-min reconcile poll instead of instant delivery.",
		);
	}

	// Explicit cap rather than the inherited 100kb default, so the bound is intentional. The
	// PR-ingest batch is the largest legitimate body; 1mb covers it without inviting a large
	// synchronous parse/validate loop as a DoS lever.
	app.use(express.json({ limit: "1mb" }));

	// Serve static UI — public; the login gate is enforced by the API, not page delivery,
	// so the frontend can always load and show an appropriate signed-in/signed-out state.
	app.use(express.static(join(__dirname, "../ui")));

	const session = requireSession(sessionSecret, allowlist, isProduction);

	// Login-establishing routes: reachable without a session (that's the point). Mounted
	// before the global `session` middleware below applies to everything else.
	app.use(
		"/account/github",
		accountRouter(oauthDeps, fetchAuthenticatedUser, allowlist, sessionSecret, isProduction, session, userTokenCache, DATA_DIR),
	);

	app.use(session);

	// Push-side companion to the per-tenant polling routes below: a global "refresh" bus,
	// not tenant data itself, so it's fine to share across every signed-in team the same
	// way the session gate above is — each client only re-polls its own tenant-scoped
	// endpoints when it fires (see routes/events.ts).
	app.use("/events", eventsRouter());

	app.use(resolveMembership(teamStore));

	// Team management (create/join/switch/invite/leave) operates on the login-level
	// membership index and team roster, not on anything a TenantContext holds — mounted
	// here, ahead of resolveTenant, so it never pays for (or depends on) resolving a
	// team's GitHub client/queue/LLM account just to manage who's on the team.
	app.use(
		"/account/team",
		teamRouter(
			teamStore,
			sessionSecret,
			publicUrl ?? `http://localhost:${PORT}`,
			(installationId) => buildInstallationOctokit(appConfig, installationId),
			DATA_DIR,
		),
	);

	app.use(resolveTenant(registry));

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
			for (const repo of tenant.accountState.current.repos) {
				enqueueRefresh(repo.owner, repo.name, tenant.refreshDeps).catch((err: unknown) => {
					if (err instanceof InstallationRevokedError) {
						console.warn(`Reconciliation poll paused for ${tenant.teamId} (${repo.owner}/${repo.name}): ${err.message}`);
						return;
					}
					if (err instanceof AccountChangedError) {
						console.warn(`Reconciliation poll for ${tenant.teamId} (${repo.owner}/${repo.name}) aborted: ${err.message}`);
						return;
					}
					console.error(`Reconciliation poll failed for ${tenant.teamId} (${repo.owner}/${repo.name}):`, err);
				});
			}
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
				console.error(`Queue branch refresh failed for ${tenant.teamId}:`, err);
			});
		}
	}, QUEUE_REFRESH_INTERVAL_MS);
	queueRefreshTimer.unref();

	// Catches a merge/close that happened directly on GitHub without Quire's webhook ever
	// firing (missed delivery, or webhooks not configured at all — see the startup warning
	// above) — the reconcile timer above only re-ingests the *review* queue's undecided PRs,
	// it never looks at bundles already accepted into the merge queue. Reuses the same
	// cadence as the queue-branch refresh rather than introducing a fourth interval knob.
	const queueGitHubSyncTimer = setInterval(() => {
		for (const tenant of registry.all()) {
			tenant.queue.reconcileWithGitHub().catch((err: unknown) => {
				console.error(`Queue GitHub-state reconcile failed for ${tenant.teamId}:`, err);
			});
		}
	}, QUEUE_REFRESH_INTERVAL_MS);
	queueGitHubSyncTimer.unref();

	// Checks in on any in-flight Managed Agents deep-investigation sessions (opt-in — see
	// tenant.ts's DeepInvestigationDeps). A no-op for tenants who never started one:
	// pollInvestigations() only touches "investigating" entries. Reuses the same cadence as
	// the queue-branch refresh above rather than introducing a third interval knob.
	const investigationPollTimer = setInterval(() => {
		for (const tenant of registry.all()) {
			tenant.queue.pollInvestigations().catch((err: unknown) => {
				console.error(`Deep conflict investigation poll failed for ${tenant.teamId}:`, err);
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
