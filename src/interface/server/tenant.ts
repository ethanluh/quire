import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { Router } from "express";
import { GitHubClientHolder } from "../../engine/github/clientHolder.js";
import { MultiRepoGitHubClient } from "../../engine/github/multiRepoClient.js";
import { loadInstallation } from "../../engine/github/installation.js";
import {
	buildInstallationClient,
	buildInstallationOctokit,
	getInstallationAccount,
	listInstallationsForUser,
	mintScopedRepoToken,
} from "../../engine/github/installationClient.js";
import type { GitHubAppConfig } from "../../engine/github/installationClient.js";
import type { OAuthDeps } from "../../engine/github/oauth.js";
import { listInstallationRepositories } from "../../engine/github/repos.js";
import type { RepoSummary } from "../../engine/github/repos.js";
import type { UserTokenCache } from "../../engine/github/userTokenCache.js";
import { sanitizeIdentifier } from "../../engine/util/identifier.js";
import type { TeamStore } from "../../engine/team/teamStore.js";
import { MergeQueue, DEFAULT_MERGEABILITY_POLL_DELAYS_MS } from "../../engine/queue/mergeQueue.js";
import type { DeepInvestigationDeps } from "../../engine/queue/mergeQueue.js";
import { ensureDeepResolverAgent } from "../../engine/queue/deepConflictInvestigation.js";
import { AnthropicManagedAgentsClient } from "../../engine/queue/managedAgentsClient.js";
import { DecidedPrStore } from "../../engine/queue/decidedPrStore.js";
import { notifyStateChanged } from "./changeEvents.js";
import { PrEffectCache } from "../../engine/cache/prCache.js";
import { AuditStore, loadAuditStore } from "../../engine/gate/auditStore.js";
import { GateConfigStore, resolveEffectiveGateConfig } from "../../engine/gate/gateConfigStore.js";
import { LlmProviderHolder } from "../../engine/drift/effectList/providerHolder.js";
import type { StaticAnalyzer } from "../../engine/drift/footprint/analyzer.js";
import { loadAccount as loadLlmAccount } from "../../engine/llm/account.js";
import { createNdjsonInstrumentationSink } from "../../engine/instrumentation/logger.js";
import type { PipelineConfig } from "../../engine/pipeline/pipeline.js";
import type { GateConfig } from "../../engine/types/gate.js";
import { createAccountState, installationForRepo, repoBinding } from "./accountState.js";
import type { AccountState } from "./accountState.js";
import { createLlmAccountState } from "./llmAccountState.js";
import type { LlmAccountState } from "./llmAccountState.js";
import { createServerState, hydrateShelf } from "./state.js";
import type { ServerState } from "./state.js";
import type { PipelineDeps } from "./ingestIntoQueue.js";
import type { RefreshDeps } from "./refreshRepoQueue.js";
import { resolveLlmProvider, buildLlmProviderFromAccount } from "./resolveLlmProvider.js";
import type { ResolvedLlmProvider } from "./resolveLlmProvider.js";
import { prsRouter } from "./routes/prs.js";
import { bundlesRouter } from "./routes/bundles.js";
import { gesturesRouter } from "./routes/gestures.js";
import { assignmentsRouter } from "./routes/assignments.js";
import { queueRouter } from "./routes/queue.js";
import { shelfRouter } from "./routes/shelf.js";
import { auditRouter } from "./routes/audit.js";
import { adminRouter } from "./routes/admin.js";
import { githubAppRouter } from "./routes/githubApp.js";
import { llmAccountRouter } from "./routes/llmAccount.js";
import { eventsRouter } from "./routes/events.js";

// A teamId is always one this process minted itself (see teamStore.ts's randomBytes hex
// id), but it's joined straight into a filesystem path below, so it's validated
// defensively rather than trusted blindly — through the shared sanitizeIdentifier
// (engine/util/identifier.ts), which teamStore.ts's sanitizeLogin also uses; the kind
// argument keeps this call's distinct "tenant data / team id" error message.

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
	// Narrows the merged, installation-scoped repo list down to what the requesting user can
	// personally see on GitHub (public, owned, or shared with them) — see repos.ts's
	// filterReposAccessibleToUser for why this can't just piggyback on enrichWithUserToken's
	// best-effort degrade.
	filterReposForUser: (repos: ReadonlyArray<RepoSummary>, accessToken: string) => Promise<ReadonlyArray<RepoSummary>>;
	// Single-repo counterpart, used by POST /repos/select to re-check server-side that the
	// requester can actually see the specific repo they're adding — the GET /repos filter above
	// is a picker convenience, not a security boundary on its own.
	canUserAccessRepo: (owner: string, name: string, accessToken: string) => Promise<boolean>;
	// Needed to silently mint a fresh user access token from a persisted refresh token on
	// tenant load (see refreshUserTokenFromDisk in userToken.ts) — the same OAuth app config
	// routes/account.ts uses for the initial exchange.
	oauth: OAuthDeps;
	// The same process-wide TeamStore instance index.ts hands teamRouter — needed here so a
	// repo-unbind route (see githubAppRouter's listTeamMemberLogins) can look up the team's
	// current roster and revoke GitHub collaborator access for every member on the repo
	// being unbound, not just whoever happens to leave/rejoin afterward.
	teamStore: TeamStore;
	// Whether index.ts actually mounted the webhook receiver (QUIRE_PUBLIC_URL and
	// GITHUB_APP_WEBHOOK_SECRET both set) — surfaced to the client via /repos/select's
	// response so a team with webhooks off knows updates rely on polling instead.
	webhooksEnabled: boolean;
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
	// Recomputes this tenant's effective gate config from the current platform default
	// (shared.pipelineConfig.gate.criteria) layered with its own GateConfigStore override.
	// The team's own /admin/gate-config PATCH already calls this internally (see below);
	// exposed here so index.ts can also call it on every already-loaded tenant right after
	// a platform-wide default change (PATCH /platform-admin/gate-config), instead of that
	// change only taking effect on a tenant's next cold start.
	refreshGateConfig: () => void;
	// Every route mounted behind a session, composed once per tenant from the exact same
	// router factories index.ts used to call once at startup — building N independent
	// instances (one per tenant) instead of one shared instance is what gives each tenant
	// its own repoListCache/connectInFlight-style router-local state too, for free.
	router: Router;
}

function sanitizeTeamId(teamId: string): string {
	return sanitizeIdentifier(teamId, { scope: "tenant data", label: "team id" });
}

async function loadTenant(teamId: string, shared: TenantSharedConfig, registry: TenantRegistry): Promise<TenantContext> {
	const dir = join(shared.dataDir, "teams", teamId);
	const installationPath = join(dir, "installation.json");
	const llmAccountPath = join(dir, "llm-account.json");
	const queuePath = join(dir, "queue.json");
	const decidedPrsPath = join(dir, "decided-prs.json");
	const prCachePath = join(dir, "pr-cache.json");
	const shelfPath = join(dir, "shelf.json");
	const deferLogPath = join(dir, "instrumentation/defers.ndjson");
	const gateLogPath = join(dir, "instrumentation/gate-decisions.ndjson");
	const driftScreenLogPath = join(dir, "instrumentation/drift-screen.ndjson");
	const conflictLogPath = join(dir, "instrumentation/conflict-resolution.ndjson");
	const auditLogPath = join(dir, "instrumentation/audit.ndjson");
	const gateConfigPath = join(dir, "gate-config.json");

	const decidedStore = new DecidedPrStore(decidedPrsPath);
	const prCache = new PrEffectCache(prCachePath);
	const gateConfigStore = new GateConfigStore(gateConfigPath);
	const state = createServerState();

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
		hydrateShelf(state.shelf, shelfPath),
		gateConfigStore.load(),
	]);
	const accountState = createAccountState(installationAccountState);

	// One client per team, dispatching every call to whichever installation backs the
	// (owner, repo) it concerns — resolved live against accountState.current.repos on every
	// call, so adding/removing a watched repo or rebinding an installation just works without
	// ever repointing this holder (see MultiRepoGitHubClient's own comment).
	const clientHolder = new GitHubClientHolder(
		new MultiRepoGitHubClient(
			(owner, name) => installationForRepo(accountState.current, owner, name)?.installationId,
			(installationId) => buildInstallationClient(shared.appConfig, installationId),
		),
	);

	// Resolved before MergeQueue below, which needs a provider for conflict resolution.
	const llmAccountState = createLlmAccountState(connectedLlmAccount);
	const { provider: initialLlmProvider } =
		connectedLlmAccount !== undefined ? buildLlmProviderFromAccount(connectedLlmAccount) : shared.resolveDefaultLlmProvider();
	const llmProviderHolder = new LlmProviderHolder(initialLlmProvider);

	// Reused across investigations for this tenant, never re-minted per call (see
	// ensureDeepResolverAgent's own guidance) — persisted next to the tenant's other
	// per-account state.
	const deepResolverAgentPath = join(dir, "deep-resolver-agent.json");
	const deepInvestigation: DeepInvestigationDeps = {
		shouldEnable: (owner, name) => repoBinding(accountState.current, owner, name)?.enableDeepConflictInvestigation === true,
		// This tier is Anthropic-only (see the design decision it implements): a Gemini or
		// stub-backed account has nothing for it to run against.
		getClient: () =>
			llmAccountState.current?.provider === "anthropic" ? new AnthropicManagedAgentsClient(llmAccountState.current.apiKey) : undefined,
		ensureAgent: (client) => ensureDeepResolverAgent(client, deepResolverAgentPath),
		mintRepoToken: (owner, repo) => {
			const installationId = installationForRepo(accountState.current, owner, repo)?.installationId;
			if (installationId === undefined) throw new Error(`No GitHub App installation bound for ${owner}/${repo}`);
			return mintScopedRepoToken(shared.appConfig, installationId, repo);
		},
	};

	const queue = new MergeQueue(
		queuePath,
		clientHolder,
		llmProviderHolder,
		conflictLogPath,
		DEFAULT_MERGEABILITY_POLL_DELAYS_MS,
		(owner, name) => repoBinding(accountState.current, owner, name)?.flagConflictsForFleet === true,
		deepInvestigation,
		() => notifyStateChanged(teamId),
	);
	await queue.load();

	// Resolves this team's effective gate criteria modes: its own GateConfigStore override
	// (if any) layered onto the platform-wide default (shared.pipelineConfig.gate.criteria).
	// Recomputed (not just read once) so a PATCH /admin/gate-config takes effect on the very
	// next pipeline run without needing a restart — see the adminRouter wiring below, which
	// calls this again after every save.
	function computeGateConfig(): GateConfig {
		return {
			criteria: resolveEffectiveGateConfig(shared.pipelineConfig.gate.criteria, gateConfigStore.get()),
			...(shared.pipelineConfig.gate.scopeKeywords !== undefined ? { scopeKeywords: shared.pipelineConfig.gate.scopeKeywords } : {}),
		};
	}

	const instrumentationSink = createNdjsonInstrumentationSink({ gateLogPath, driftScreenLogPath });
	const pipelineDeps: PipelineDeps = {
		config: { gate: computeGateConfig(), bundle: shared.pipelineConfig.bundle },
		provider: llmProviderHolder,
		analyzer: shared.analyzer,
		auditStore,
		prCache,
		instrumentationSink,
	};

	// Same object every pipelineDeps-consuming closure (prsRouter, refreshRepoQueue, ...)
	// already captured by reference — reassigning .config here is what makes a saved
	// override (team-level, via adminRouter's onChange below) or a platform-wide default
	// change (via index.ts calling this on every loaded tenant) visible to the very next
	// pipeline run without re-wiring any of those closures.
	function refreshGateConfig(): void {
		pipelineDeps.config = { gate: computeGateConfig(), bundle: shared.pipelineConfig.bundle };
	}

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
		queue,
		tenantKey: teamId,
	};

	const router = Router();
	router.use("/prs", prsRouter(state, pipelineDeps, queue));
	router.use("/bundles", bundlesRouter(state));
	router.use("/bundles", gesturesRouter(state, queue, deferLogPath, clientHolder, decidedStore, accountState, shelfPath, teamId));
	router.use("/bundles", assignmentsRouter(state));
	router.use("/queue", queueRouter(queue, state, decidedStore, accountState, teamId));
	router.use("/shelf", shelfRouter(state, decidedStore, shelfPath));
	router.use("/events", eventsRouter(teamId));
	router.use("/audit", auditRouter(auditStore));
	router.use(
		"/admin",
		adminRouter(state, auditStore, queue, [deferLogPath, gateLogPath, driftScreenLogPath, conflictLogPath], decidedStore, shelfPath, {
			store: gateConfigStore,
			// A getter, not a snapshot: index.ts can reassign shared.pipelineConfig wholesale
			// when the platform-wide default changes (PATCH /platform-admin/gate-config), and
			// this must reflect that on the very next GET/PATCH here rather than showing the
			// value that was current when this tenant first loaded.
			get platformDefault() {
				return shared.pipelineConfig.gate.criteria;
			},
			onChange: refreshGateConfig,
		}),
	);
	router.use(
		"/account/github",
		githubAppRouter({
			refreshDeps,
			appSlug: shared.appSlug,
			listInstallationRepos: (installationId, accountLogin) =>
				listInstallationRepositories(buildInstallationOctokit(shared.appConfig, installationId), installationId, accountLogin),
			getInstallationAccount: (installationId) => getInstallationAccount(shared.appConfig, installationId),
			secureCookies: shared.isProduction,
			userTokenCache: shared.userTokenCache,
			enrichWithUserToken: shared.enrichWithUserToken,
			filterReposForUser: shared.filterReposForUser,
			canUserAccessRepo: shared.canUserAccessRepo,
			listInstallationsForUser,
			dataDir: shared.dataDir,
			oauth: shared.oauth,
			buildOctokit: (installationId) => buildInstallationOctokit(shared.appConfig, installationId),
			listTeamMemberLogins: async (forTeamId) => (await shared.teamStore.listMembers(forTeamId)).map((member) => member.login),
			teamId,
			webhooksEnabled: shared.webhooksEnabled,
		}),
	);
	router.use(
		"/account/llm",
		llmAccountRouter({
			llmAccountState,
			accountPath: llmAccountPath,
			llmProviderHolder,
			buildProvider: buildLlmProviderFromAccount,
			resolveFallback: shared.resolveDefaultLlmProvider,
		}),
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
		refreshGateConfig,
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
	// out of sync with it. One installation can now be bound by several teams at once (an org
	// admin installing the App once and multiple Quire teams each connecting it), so this
	// returns every match rather than picking a single "owner" — callers (webhookRouter's
	// findTenant, in particular) fan an event out to all of them.
	findAllByInstallationId(installationId: number): ReadonlyArray<TenantContext> {
		const matches: TenantContext[] = [];
		for (const tenant of this.tenants.values()) {
			if (tenant.accountState.current.installations.some((i) => i.installationId === installationId)) matches.push(tenant);
		}
		return matches;
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
