import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { Router } from "express";
import type { GitHubClient } from "../../engine/github/client.js";
import { GitHubClientHolder } from "../../engine/github/clientHolder.js";
import { StubGitHubClient } from "../../engine/github/stubClient.js";
import { loadInstallation } from "../../engine/github/installation.js";
import {
	buildInstallationClient,
	buildInstallationOctokit,
	buildUserOctokit,
	getInstallationAccount,
} from "../../engine/github/installationClient.js";
import type { GitHubAppConfig } from "../../engine/github/installationClient.js";
import { listInstallationRepositories, enrichWithStarredAndPinned } from "../../engine/github/repos.js";
import type { RepoSummary } from "../../engine/github/repos.js";
import type { UserTokenCache } from "../../engine/github/userTokenCache.js";
import { MergeQueue, DEFAULT_MERGEABILITY_POLL_DELAYS_MS } from "../../engine/queue/mergeQueue.js";
import { DecidedPrStore } from "../../engine/queue/decidedPrStore.js";
import { PrEffectCache } from "../../engine/cache/prCache.js";
import { AuditStore, loadAuditStore } from "../../engine/gate/auditStore.js";
import { LlmProviderHolder } from "../../engine/drift/effectList/providerHolder.js";
import type { StaticAnalyzer } from "../../engine/drift/footprint/analyzer.js";
import { loadAccount as loadLlmAccount } from "../../engine/llm/account.js";
import { createNdjsonInstrumentationSink } from "../../engine/instrumentation/logger.js";
import type { PipelineConfig } from "../../engine/pipeline/pipeline.js";
import { createAccountState, activeInstallation } from "./accountState.js";
import type { AccountState } from "./accountState.js";
import { createLlmAccountState } from "./llmAccountState.js";
import type { LlmAccountState } from "./llmAccountState.js";
import { createServerState } from "./state.js";
import type { ServerState } from "./state.js";
import type { PipelineDeps } from "./ingestIntoQueue.js";
import type { RefreshDeps } from "./refreshRepoQueue.js";
import { resolveLlmProvider, buildLlmProviderFromAccount } from "./resolveLlmProvider.js";
import type { ResolvedLlmProvider } from "./resolveLlmProvider.js";
import { prsRouter } from "./routes/prs.js";
import { bundlesRouter } from "./routes/bundles.js";
import { gesturesRouter } from "./routes/gestures.js";
import { queueRouter } from "./routes/queue.js";
import { shelfRouter } from "./routes/shelf.js";
import { auditRouter } from "./routes/audit.js";
import { adminRouter } from "./routes/admin.js";
import { githubAppRouter } from "./routes/githubApp.js";
import { llmAccountRouter } from "./routes/llmAccount.js";

// A teamId is always one this process minted itself (see teamStore.ts's randomBytes hex
// id), but it's joined straight into a filesystem path below, so it's validated
// defensively rather than trusted blindly.
const VALID_TEAM_ID = /^[A-Za-z0-9-]+$/;

// Config shared by every tenant: the one GitHub App's own identity, the pipeline's
// tuning, and the single static analyzer instance — none of this is per-account data,
// unlike everything in TenantContext below.
export interface TenantSharedConfig {
	dataDir: string;
	appConfig: GitHubAppConfig;
	appSlug: string;
	pipelineConfig: PipelineConfig;
	analyzer: StaticAnalyzer;
	isProduction: boolean;
	resolveDefaultLlmProvider: () => ResolvedLlmProvider;
	// Keyed by login internally (see userTokenCache.ts), so — unlike everything else in
	// TenantContext — this and its enrichment callback are safe to share across tenants:
	// every caller only ever looks up the current request's own signed-in login.
	userTokenCache: UserTokenCache;
	enrichWithUserToken: (repos: ReadonlyArray<RepoSummary>, accessToken: string) => Promise<ReadonlyArray<RepoSummary>>;
}

// Everything that used to be a single process-wide singleton (accountState, the GitHub
// client, the LLM account, the review-queue state, the merge queue, ...) now lives here
// instead, one instance per TEAM — a second teammate connecting their own GitHub App
// installation used to silently overwrite the first's, because all of this used to be
// shared by every request regardless of who was signed in. It was briefly one instance
// per signed-in GitHub login; resolveMembership.js now maps a login to its *active*
// team's id before this is ever looked up, so several logins on the same team share one
// TenantContext (and its installation/repo/queue/API key) on purpose.
export interface TenantContext {
	teamId: string;
	accountState: AccountState;
	clientHolder: GitHubClientHolder;
	llmAccountState: LlmAccountState;
	llmProviderHolder: LlmProviderHolder;
	state: ServerState;
	queue: MergeQueue;
	decidedStore: DecidedPrStore;
	prCache: PrEffectCache;
	auditStore: AuditStore;
	refreshDeps: RefreshDeps;
	// Exposed so index.ts's per-tenant timers and webhookRouter can log to the right
	// team's instrumentation file instead of a single global one.
	conflictLogPath: string;
	// Every route mounted behind a session, composed once per tenant from the exact same
	// router factories index.ts used to call once at startup — building N independent
	// instances (one per tenant) instead of one shared instance is what gives each tenant
	// its own repoListCache/connectInFlight-style router-local state too, for free.
	router: Router;
}

function sanitizeTeamId(teamId: string): string {
	if (!VALID_TEAM_ID.test(teamId)) {
		throw new Error(`Refusing to scope tenant data to unexpected team id: ${JSON.stringify(teamId)}`);
	}
	return teamId;
}

async function loadTenant(teamId: string, shared: TenantSharedConfig, registry: TenantRegistry): Promise<TenantContext> {
	const dir = join(shared.dataDir, "teams", teamId);
	const installationPath = join(dir, "installation.json");
	const llmAccountPath = join(dir, "llm-account.json");
	const queuePath = join(dir, "queue.json");
	const decidedPrsPath = join(dir, "decided-prs.json");
	const prCachePath = join(dir, "pr-cache.json");
	const deferLogPath = join(dir, "instrumentation/defers.ndjson");
	const gateLogPath = join(dir, "instrumentation/gate-decisions.ndjson");
	const driftScreenLogPath = join(dir, "instrumentation/drift-screen.ndjson");
	const conflictLogPath = join(dir, "instrumentation/conflict-resolution.ndjson");
	const auditLogPath = join(dir, "instrumentation/audit.ndjson");

	const decidedStore = new DecidedPrStore(decidedPrsPath);
	const prCache = new PrEffectCache(prCachePath);

	// One operator (this tenant) can bind several GitHub App installations — their personal
	// account plus N orgs — and see a merged repo picker across all of them (see
	// installation.ts's InstallationAccountState). selectedRepo/autoMergeOnAccept/
	// flagConflictsForFleet live on that always-present account-wide state, not on any one
	// installation, so they already survive an individual installation's disconnect/
	// reconnect without a separate preferences store.
	//
	// None of these reads depend on another's result — run them concurrently instead of one
	// after another on this tenant's cold-start path (this is on the hot path for
	// resolveTenant's first getOrCreate call for a team, not just process startup).
	const [installationAccountState, auditStore, connectedLlmAccount] = await Promise.all([
		loadInstallation(installationPath),
		loadAuditStore(auditLogPath),
		loadLlmAccount(llmAccountPath),
		decidedStore.load(),
		prCache.load(),
	]);
	const accountState = createAccountState(installationAccountState);

	let initialClient: GitHubClient;
	const active = activeInstallation(accountState.current);
	if (active !== undefined) {
		initialClient = buildInstallationClient(shared.appConfig, active.installationId);
	} else {
		initialClient = new StubGitHubClient();
	}
	const clientHolder = new GitHubClientHolder(initialClient);

	// Resolved before MergeQueue below, which needs a provider for conflict resolution.
	const llmAccountState = createLlmAccountState(connectedLlmAccount);
	const { provider: initialLlmProvider } =
		connectedLlmAccount !== undefined ? buildLlmProviderFromAccount(connectedLlmAccount) : shared.resolveDefaultLlmProvider();
	const llmProviderHolder = new LlmProviderHolder(initialLlmProvider);

	const queue = new MergeQueue(
		queuePath,
		clientHolder,
		llmProviderHolder,
		conflictLogPath,
		DEFAULT_MERGEABILITY_POLL_DELAYS_MS,
		() => accountState.current.flagConflictsForFleet === true,
	);
	await queue.load();

	const instrumentationSink = createNdjsonInstrumentationSink({ gateLogPath, driftScreenLogPath });
	const pipelineDeps: PipelineDeps = {
		config: shared.pipelineConfig,
		provider: llmProviderHolder,
		analyzer: shared.analyzer,
		auditStore,
		prCache,
		instrumentationSink,
	};

	const state = createServerState();

	// tenantKey scopes enqueueRefresh's per-repo coalescing lock so two tenants who happen
	// to select the same owner/name can never short-circuit each other's refresh.
	const refreshDeps: RefreshDeps = {
		accountState,
		accountPath: installationPath,
		clientHolder,
		appConfig: shared.appConfig,
		decidedStore,
		state,
		pipelineDeps,
		tenantKey: teamId,
	};

	const router = Router();
	router.use("/prs", prsRouter(state, pipelineDeps, queue));
	router.use("/bundles", bundlesRouter(state));
	router.use("/bundles", gesturesRouter(state, queue, deferLogPath, clientHolder, decidedStore, accountState));
	router.use("/queue", queueRouter(queue, state, decidedStore));
	router.use("/shelf", shelfRouter(state, decidedStore));
	router.use("/audit", auditRouter(auditStore));
	router.use(
		"/admin",
		adminRouter(state, auditStore, queue, [deferLogPath, gateLogPath, driftScreenLogPath, conflictLogPath], decidedStore),
	);
	router.use(
		"/account/github",
		githubAppRouter(
			refreshDeps,
			shared.appSlug,
			(installationId) => buildInstallationClient(shared.appConfig, installationId),
			(installationId, accountLogin) =>
				listInstallationRepositories(buildInstallationOctokit(shared.appConfig, installationId), installationId, accountLogin),
			(installationId) => getInstallationAccount(shared.appConfig, installationId),
			shared.isProduction,
			shared.userTokenCache,
			(repos, accessToken) => enrichWithStarredAndPinned(repos, buildUserOctokit(accessToken)),
			(installationId) => registry.isInstallationBoundToOtherTeam(installationId, teamId),
		),
	);
	router.use(
		"/account/llm",
		llmAccountRouter(llmAccountState, llmAccountPath, llmProviderHolder, buildLlmProviderFromAccount, shared.resolveDefaultLlmProvider),
	);

	return {
		teamId,
		accountState,
		clientHolder,
		llmAccountState,
		llmProviderHolder,
		state,
		queue,
		decidedStore,
		prCache,
		auditStore,
		refreshDeps,
		conflictLogPath,
		router,
	};
}

// Keyed by teamId (see teamStore.ts — every login resolves to one via its membership
// index before this is ever called). One TenantContext per team, created lazily on that
// team's first request and reused for the life of the process.
export class TenantRegistry {
	private readonly tenants = new Map<string, TenantContext>();
	private readonly loading = new Map<string, Promise<TenantContext>>();

	constructor(private readonly shared: TenantSharedConfig) {}

	async getOrCreate(teamId: string): Promise<TenantContext> {
		const key = sanitizeTeamId(teamId);
		const existing = this.tenants.get(key);
		if (existing !== undefined) return existing;

		const alreadyLoading = this.loading.get(key);
		if (alreadyLoading !== undefined) return alreadyLoading;

		const promise = loadTenant(key, this.shared, this).then((tenant) => {
			this.tenants.set(key, tenant);
			this.loading.delete(key);
			return tenant;
		});
		this.loading.set(key, promise);
		return promise;
	}

	all(): ReadonlyArray<TenantContext> {
		return [...this.tenants.values()];
	}

	// A linear scan over (typically a handful of) tenants, each scanning its own (typically
	// small) installations[] array, instead of a maintained reverse index —
	// accountState.current.installations is the one place installationId already lives, kept
	// up to date by githubApp.ts's existing routes, so there's nothing else that could drift
	// out of sync with it. One tenant can bind several installations, so this can't stop at
	// the first tenant whose *selected* installation doesn't match — it has to check every
	// installation that tenant has ever bound.
	findByInstallationId(installationId: number): TenantContext | undefined {
		for (const tenant of this.tenants.values()) {
			if (tenant.accountState.current.installations.some((i) => i.installationId === installationId)) return tenant;
		}
		return undefined;
	}

	// True when some OTHER already-loaded team has this installation bound. Checked by
	// githubApp.ts's install callback before it binds — without this, two teams could each
	// bind the same installation and findByInstallationId's scan above would then route
	// every webhook for it to whichever team happened to load first, silently starving the
	// other's queue with no error on either side.
	isInstallationBoundToOtherTeam(installationId: number, exceptTeamId: string): boolean {
		const owner = this.findByInstallationId(installationId);
		return owner !== undefined && owner.teamId !== exceptTeamId;
	}

	// Loads every team that has ever connected anything, so the reconciliation poll and
	// incoming webhooks work for a teammate who isn't actively browsing right now — not
	// just the tenants lazily created by getOrCreate on their next request.
	async hydrateExisting(): Promise<void> {
		const teamsDir = join(this.shared.dataDir, "teams");
		if (!existsSync(teamsDir)) return;
		const entries = await readdir(teamsDir, { withFileTypes: true });
		await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => this.getOrCreate(entry.name)));
	}
}
