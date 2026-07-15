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
import { createAllowlist, createPlatformAdminAllowlist } from "./allowlist.js";
import type { Allowlist } from "./allowlist.js";
import { PlatformAllowlistStore } from "../../engine/platform/platformAllowlistStore.js";
import { PlatformGateDefaultsStore } from "../../engine/platform/platformGateDefaultsStore.js";
import type { GateCriterion } from "../../engine/types/gate.js";
import { requireSession } from "./middleware/requireSession.js";
import { resolveMembership } from "./middleware/resolveMembership.js";
import { resolveTenant } from "./middleware/resolveTenant.js";
import { accountRouter } from "./routes/account.js";
import { createSessionEpochStore } from "./sessionEpoch.js";
import { teamRouter } from "./routes/team.js";
import { platformAdminRouter } from "./routes/platformAdmin.js";
import { migrateLegacyData } from "./migrateLegacyData.js";
import { TeamStore } from "../../engine/team/teamStore.js";
import type { WebhookConfig } from "./routes/webhook.js";
import { webhookRouter } from "./routes/webhook.js";
import { verifyGithubSignature } from "./middleware/webhookSignature.js";
import { errorHandler } from "./middleware/errors.js";
import type { PipelineConfig } from "../../engine/pipeline/pipeline.js";
import { setUpDeclaredDirectionConvention } from "../../engine/github/repoSetup.js";
import { bundleAutoMergeEnabled } from "./accountState.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Not derived from __dirname: the compiled dist/ output nests one level deeper than the
// source (dist/src/interface/server vs. src/interface/server), so a fixed "../../../data"
// walk lands in the wrong place in production. process.cwd() is stable across `npm run dev`
// and `npm start` (both invoked from the project root); QUIRE_DATA_DIR lets a deploy mount
// its persistent volume anywhere.
const DATA_DIR = process.env.QUIRE_DATA_DIR ?? join(process.cwd(), "data");

const PORT = parseInt(process.env["PORT"] ?? "3000", 10);
const QUEUE_REFRESH_INTERVAL_MS =
	parseInt(process.env["QUIRE_QUEUE_REFRESH_INTERVAL_MINUTES"] ?? "5", 10) * 60 * 1000;

// A bundle sitting "waitingOnChecks" is a merge actively in progress from the human's point of
// view (they already accepted it) — worth polling far tighter than the general reconcile
// cadence above so it lands promptly once checks turn green, even if the check_suite/
// pull_request_review webhook delivery is missed or webhooks aren't configured at all.
const CHECKS_POLL_INTERVAL_MS = parseInt(process.env["QUIRE_CHECKS_POLL_INTERVAL_SECONDS"] ?? "20", 10) * 1000;

// Opening/updating a setup PR is more visible (and more GitHub-API-call-heavy — 6 file reads per
// repo) than a plain refresh, so this defaults to once a day rather than reusing the tighter
// refresh cadences. An explicit QUIRE_SETUP_RECONCILE_INTERVAL_MINUTES overrides it; empty or
// non-numeric values fall back rather than becoming a NaN interval, same defensiveness as
// QUIRE_RECONCILE_INTERVAL_MINUTES below.
const parsedSetupReconcileMinutes = parseInt(process.env["QUIRE_SETUP_RECONCILE_INTERVAL_MINUTES"] ?? "", 10);
const SETUP_RECONCILE_INTERVAL_MS =
	(Number.isFinite(parsedSetupReconcileMinutes) && parsedSetupReconcileMinutes > 0 ? parsedSetupReconcileMinutes : 1440) * 60 * 1000;

// The historical hardcoded gate config — now only the SEED for PlatformGateDefaultsStore's
// first boot (see main()), not the live config. Once that store has ever been written to
// (by main()'s own seeding, or a platform admin's PATCH /platform-admin/gate-config), its
// persisted value wins on every subsequent boot.
const DEFAULT_GATE_CRITERIA: ReadonlyArray<GateCriterion> = [
	{ name: "buildFailure", mode: "enforce" },
	{ name: "outOfScope", mode: "off" },
	{ name: "duplicate", mode: "shadow" },
];

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
	// Gate on the PARSED result, not raw string-emptiness: a value like "," or " " is non-empty
	// as a string but parses to an effectively-empty (allow-all) allowlist, which would sail past
	// a `=== ""` check and silently admit every GitHub account in production. createAllowlist is
	// the single source of truth for what "allow-all" means; the explicit "*" is the one allow-all
	// a host may opt into when hosting.
	const allowlist = createAllowlist(allowedLogins);
	if (allowlist.allowsAll && !allowlist.explicitWildcard) {
		if (isProduction) {
			throw new Error(
				"QUIRE_ALLOWED_GITHUB_LOGINS must be set when hosting (QUIRE_PUBLIC_URL is https) — " +
					"an empty allowlist would let any GitHub account sign in. Set a comma-separated login list, or \"*\" to intentionally allow all.",
			);
		}
		console.warn("QUIRE_ALLOWED_GITHUB_LOGINS not set (or empty) — any GitHub account can sign in. Set this before hosting.");
	}

	// Gates /platform-admin/* — a wholly separate, higher-privilege allowlist from the base
	// sign-in one above, scoped to whoever operates this Quire instance across every team,
	// not any one team's owner/admin. Unlike the base allowlist, unset/empty here fails
	// CLOSED (no one is a platform admin) rather than open — see createPlatformAdminAllowlist.
	const rawPlatformAdminLogins = process.env["QUIRE_PLATFORM_ADMIN_LOGINS"];
	const platformAdminAllowlist = createPlatformAdminAllowlist(rawPlatformAdminLogins);
	if (platformAdminAllowlist.explicitWildcard && isProduction) {
		throw new Error(
			'QUIRE_PLATFORM_ADMIN_LOGINS="*" would grant cross-tenant platform-admin access to any signed-in GitHub account — ' +
				"not allowed when hosting. Set an explicit comma-separated login list instead.",
		);
	}
	const platformAdminLoginsConfigured = rawPlatformAdminLogins !== undefined && rawPlatformAdminLogins.trim() !== "";
	if (!platformAdminLoginsConfigured) {
		console.warn(
			"QUIRE_PLATFORM_ADMIN_LOGINS not set — the platform admin console is unreachable by anyone. " +
				"Set it to your GitHub login(s) to use it.",
		);
	}

	// A persisted, editable supplement to the env-var allowlist above (see PATCH
	// /platform-admin/access-control) and the platform-wide gate-criteria defaults every
	// team inherits unless it sets its own override (see PATCH /platform-admin/gate-config).
	// Both live under data/platform/, alongside the admin-actions trail every mutation to
	// either one gets appended to.
	const platformAllowlistStore = new PlatformAllowlistStore(join(DATA_DIR, "platform", "allowed-logins.json"));
	await platformAllowlistStore.load();
	const platformGateDefaultsStore = new PlatformGateDefaultsStore(join(DATA_DIR, "platform", "gate-config.json"));
	await platformGateDefaultsStore.load();
	let gateDefaults = platformGateDefaultsStore.get();
	if (gateDefaults === undefined) {
		gateDefaults = DEFAULT_GATE_CRITERIA;
		await platformGateDefaultsStore.set(gateDefaults);
	}
	const platformAdminActionLogPath = join(DATA_DIR, "platform", "admin-actions.ndjson");

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

	// With webhooks delivering changes as they happen, the reconcile poll is only a safety
	// net and 20 minutes is plenty. Without them it is the *primary* ingestion channel, and a
	// 20-minute floor is exactly the "PRs show up whenever" experience — poll every 5 minutes
	// instead (not tighter: each refresh costs ~3 API calls per open PR, and a busy repo at a
	// faster cadence brushes the GitHub App's 5000/hr installation limit). An explicit
	// QUIRE_RECONCILE_INTERVAL_MINUTES overrides either default; empty or non-numeric values
	// fall back rather than becoming a NaN interval (.env.example ships the key blank).
	const defaultReconcileMinutes = webhookConfig !== undefined ? 20 : 5;
	const parsedReconcileMinutes = parseInt(process.env["QUIRE_RECONCILE_INTERVAL_MINUTES"] ?? "", 10);
	const reconcileMinutes =
		Number.isFinite(parsedReconcileMinutes) && parsedReconcileMinutes > 0 ? parsedReconcileMinutes : defaultReconcileMinutes;
	const reconcileIntervalMs = reconcileMinutes * 60 * 1000;

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

	const pipelineConfig: PipelineConfig = {
		gate: { criteria: gateDefaults },
		bundle: { similarityThreshold: 0.75 },
	};

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
	// binding several, and the same installation possibly bound by several tenants) — each
	// delivery is fanned out to every tenant that has this installation bound (see
	// webhookRouter and TenantRegistry.findAllByInstallationId).
	if (webhookConfig !== undefined) {
		app.use(
			"/webhooks/github",
			express.raw({ type: "application/json", limit: "1mb" }),
			verifyGithubSignature(webhookConfig.secret),
			webhookRouter((installationId) => registry.findAllByInstallationId(installationId).map((tenant) => ({ refreshDeps: tenant.refreshDeps }))),
		);
		console.log("GitHub webhook receiver: enabled at /webhooks/github");
	} else {
		console.warn(
			"GitHub webhook receiver disabled (set QUIRE_PUBLIC_URL and GITHUB_APP_WEBHOOK_SECRET to enable; " +
				"for local dev, point the App's webhook at a smee.io channel or an `ngrok http 3000` tunnel) — " +
				`PR updates rely on the 60s background refresh and the ${reconcileMinutes}-min reconcile poll instead of instant delivery.`,
		);
	}

	// Explicit cap rather than the inherited 100kb default, so the bound is intentional. The
	// PR-ingest batch is the largest legitimate body; 1mb covers it without inviting a large
	// synchronous parse/validate loop as a DoS lever.
	app.use(express.json({ limit: "1mb" }));

	// Serve static UI — public; the login gate is enforced by the API, not page delivery,
	// so the frontend can always load and show an appropriate signed-in/signed-out state.
	app.use(express.static(join(__dirname, "../ui")));

	const sessionEpochs = createSessionEpochStore(DATA_DIR);
	const session = requireSession(sessionSecret, allowlist, isProduction, sessionEpochs);

	// Login-establishing routes: reachable without a session (that's the point). Mounted
	// before the global `session` middleware below applies to everything else.
	app.use(
		"/account/github",
		accountRouter(oauthDeps, fetchAuthenticatedUser, allowlist, sessionSecret, isProduction, session, userTokenCache, DATA_DIR, sessionEpochs),
	);

	app.use(session);

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

	// OR's the env-var floor with the persisted supplemental list — never the other way
	// around: the env var alone still fully determines the fail-closed-when-unset default
	// (see createPlatformAdminAllowlist), this only ever adds more logins on top of it.
	const combinedPlatformAdminAllowlist: Allowlist = {
		isAllowed: (login) => platformAdminAllowlist.isAllowed(login) || platformAllowlistStore.get().includes(login.toLowerCase()),
		allowsAll: platformAdminAllowlist.allowsAll,
		explicitWildcard: platformAdminAllowlist.explicitWildcard,
	};

	// Persists the new platform-wide default AND pushes it live to every already-loaded
	// tenant (registry.all() — hydrateExisting() already loaded every team at boot, see
	// above) via TenantContext.refreshGateConfig, so the change takes effect immediately
	// rather than only for tenants that cold-start after this call.
	async function applyGateDefaults(criteria: ReadonlyArray<GateCriterion>): Promise<void> {
		await platformGateDefaultsStore.set(criteria);
		sharedConfig.pipelineConfig = { ...sharedConfig.pipelineConfig, gate: { ...sharedConfig.pipelineConfig.gate, criteria } };
		for (const tenant of registry.all()) tenant.refreshGateConfig();
	}

	// Cross-tenant — mounted ahead of resolveTenant like teamRouter above, since it
	// deliberately reads every team's TenantContext at once rather than the one request's
	// own resolved team. Gated by requirePlatformAdmin (combinedPlatformAdminAllowlist), a
	// separate and higher-privilege check than any team's role.
	app.use(
		"/platform-admin",
		platformAdminRouter(registry, teamStore, combinedPlatformAdminAllowlist, {
			envAllowlist: platformAdminAllowlist,
			envConfigured: platformAdminLoginsConfigured,
			allowlistStore: platformAllowlistStore,
			gateDefaultsStore: platformGateDefaultsStore,
			applyGateDefaults,
			adminActionLogPath: platformAdminActionLogPath,
		}),
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

	// Catch-all for unmatched paths — without this, Express's default `finalhandler` 404
	// negotiates to an HTML "Cannot GET /x" page (the frontend's `api()` helper sends no
	// `Accept` header), which the client can't parse as JSON and surfaces as an opaque
	// "Unexpected non-JSON response from the server" error instead of a real 404 message.
	app.use((req, res) => {
		res.status(404).json({ error: "Not found" });
	});

	app.use(errorHandler);

	// Independent of webhooks — a safety net for a missed delivery, and the sole detection
	// mechanism if webhooks aren't configured. Iterates every known tenant (not just the
	// ones actively browsing) so a teammate's repo stays in sync even while they're away.
	const reconcileTimer = setInterval(() => {
		for (const tenant of registry.all()) {
			for (const repo of tenant.accountState.current.repos) {
				enqueueRefresh(repo.owner, repo.name, tenant.refreshDeps)
					.then((result) => {
						if (result.error !== undefined) {
							console.error(
								`Reconciliation poll for ${tenant.teamId} (${repo.owner}/${repo.name}) ingested with errors: ${result.error}`,
							);
						}
					})
					.catch((err: unknown) => {
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
	}, reconcileIntervalMs);
	reconcileTimer.unref();

	// Re-runs Quire's declared-direction setup PR against every repo of every known tenant, so a
	// change to the convention's own content (PR template, CLAUDE.md section, CI workflow, hooks)
	// reaches repos that were onboarded before the change — not just newly onboarded ones.
	// setUpDeclaredDirectionConvention() already short-circuits to "already-set-up" once every
	// item conforms, so calling it on a schedule is a no-op except when something actually
	// drifted. Same cross-tenant iteration and per-repo error isolation as the reconcile timer.
	const setupReconcileTimer = setInterval(() => {
		for (const tenant of registry.all()) {
			for (const repo of tenant.accountState.current.repos) {
				setUpDeclaredDirectionConvention(tenant.clientHolder, repo.owner, repo.name).catch((err: unknown) => {
					if (err instanceof InstallationRevokedError) {
						console.warn(`Declared-direction setup rerun paused for ${tenant.teamId} (${repo.owner}/${repo.name}): ${err.message}`);
						return;
					}
					if (err instanceof AccountChangedError) {
						console.warn(`Declared-direction setup rerun for ${tenant.teamId} (${repo.owner}/${repo.name}) aborted: ${err.message}`);
						return;
					}
					console.error(`Declared-direction setup rerun failed for ${tenant.teamId} (${repo.owner}/${repo.name}):`, err);
				});
			}
		}
	}, SETUP_RECONCILE_INTERVAL_MS);
	setupReconcileTimer.unref();

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

	// Tighter-cadence backstop for bundles parked "waitingOnChecks" — a merge the human
	// already accepted, just deferred until CI clears (see MergeQueue.dequeueNextLocked). Only
	// drains a newly-cleared entry itself if that entry's repos opted into autoMergeOnAccept,
	// same gate every other auto-merge trigger (gestures.ts, routes/queue.ts, routes/
	// webhook.ts) uses — this timer only ever promotes "waitingOnChecks" to "queued", it never
	// bypasses that opt-in.
	const checksPollTimer = setInterval(() => {
		for (const tenant of registry.all()) {
			tenant.queue
				.pollWaitingOnChecks()
				.then((cleared) => {
					for (const entry of cleared) {
						if (bundleAutoMergeEnabled(tenant.accountState.current, entry.bundle)) {
							tenant.queue.dequeueNext().catch((err: unknown) => {
								console.error(`Background auto-merge failed for ${tenant.teamId} (${entry.bundleId}):`, err);
							});
						}
					}
				})
				.catch((err: unknown) => {
					console.error(`Waiting-on-checks poll failed for ${tenant.teamId}:`, err);
				});
		}
	}, CHECKS_POLL_INTERVAL_MS);
	checksPollTimer.unref();

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
