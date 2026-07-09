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
import { LlmProviderHolder } from "../../engine/drift/effectList/providerHolder.js";
import type { StaticAnalyzer } from "../../engine/drift/footprint/analyzer.js";
import { loadAccount as loadLlmAccount } from "../../engine/llm/account.js";
import { createNdjsonInstrumentationSink } from "../../engine/instrumentation/logger.js";
import type { InstrumentationSink } from "../../engine/types/instrumentation.js";
import type { PipelineConfig } from "../../engine/pipeline/pipeline.js";
import { resolveJudgeThresholds } from "../../engine/judge/gate.js";
import { loadJudgeVerdictStore } from "../../engine/judge/judgeVerdictStore.js";
import { loadJudgeActionStore } from "../../engine/judge/judgeActionStore.js";
import type { ActionPipelineDeps } from "../../engine/judge/actionPipeline.js";
import type { JudgeRunDeps } from "../../engine/judge/orchestrate.js";
import type { JudgeConstitution, JudgeMode } from "../../engine/types/judge.js";
import type { ShelfState } from "../../engine/types/shelf.js";
import type { SlackNotifier } from "../notify/slack.js";
import { resolveJudgeProvider } from "./resolveJudgeProvider.js";
import { createAccountState, installationForRepo, repoBinding } from "./accountState.js";
import type { AccountState } from "./accountState.js";
import { createLlmAccountState } from "./llmAccountState.js";
import type { LlmAccountState } from "./llmAccountState.js";
import { createServerState, hydrateShelf } from "./state.js";
import type { ServerState, ShelvedBundle } from "./state.js";
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
import { judgeRouter } from "./routes/judge.js";

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
	// undefined when docs/judge-constitution.md failed to load at startup (missing/malformed)
	// — the judge is disabled process-wide in that case, logged once at startup, never a
	// crash (see index.ts). The constitution is a single repo-level document, not per-team
	// data, so it's resolved once here rather than per tenant.
	judgeConstitution: JudgeConstitution | undefined;
	// Resolved once from QUIRE_JUDGE_MODE at startup (default "shadow" — see
	// docs/judge-integration-map.md §7 for why "off" is a superset value beyond the mission's
	// three-mode description). A deployment-wide setting, not per-team, matching how it's a
	// single env var rather than a per-repo UI toggle like autoMergeOnAccept.
	judgeMode: JudgeMode;
	// Deployment-wide, matching judgeMode/judgeConstitution above — a single Slack
	// destination and read-only health-check URL for every team's judge, not a per-team UI
	// setting. resolveSlackNotifier already degrades to a no-op when unconfigured.
	slack: SlackNotifier;
	judgeHealthCheckUrl: string | undefined;
	judgeVerifyTimeoutMs: number;
	// Fraction (0..1) of gate-allowed "auto" mode verdicts routed to a human instead of
	// auto-acted on, purely for judge-vs-human agreement calibration (mission §I). 0 samples
	// nothing.
	judgeAuditSampleRate: number;
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
	// undefined whenever this tenant's judge isn't running in "auto" mode — exposed
	// separately from judgeDeps (embedded in pipelineDeps) so both the webhook route (see
	// webhook.ts's WebhookTenant) and index.ts's verification-timeout sweep can reach the
	// exact same ActionPipelineDeps instance the ingest-triggered path uses, rather than a
	// second, divergent copy.
	judgeActionDeps?: ActionPipelineDeps;
	// Every route mounted behind a session, composed once per tenant from the exact same
	// router factories index.ts used to call once at startup — building N independent
	// instances (one per tenant) instead of one shared instance is what gives each tenant
	// its own repoListCache/connectInFlight-style router-local state too, for free.
	router: Router;
}

function sanitizeTeamId(teamId: string): string {
	return sanitizeIdentifier(teamId, { scope: "tenant data", label: "team id" });
}

// Same conversion saveShelf (state.ts) does when persisting — duplicated rather than
// imported from there because saveShelf's shape is tied to its own on-disk ShelfState, and
// this is a read-only, in-memory view for precedent.ts; keeping them separate means a future
// change to one's persistence format doesn't have to consider this call site too.
function shelfStateFromMap(shelf: ReadonlyMap<string, ShelvedBundle>): ShelfState {
	return { entries: [...shelf.entries()].map(([bundleId, shelved]) => ({ bundleId, ...shelved })) };
}

// undefined whenever the judge can't safely run for this tenant: no constitution loaded
// (index.ts already logged why), mode is "off", or the constitution's own thresholds fail to
// resolve (a bad QUIRE_JUDGE_* override) — every case degrades to "no judge for this tenant,
// logged, ingestion otherwise unaffected" rather than blocking tenant load.
async function buildJudgeRunDeps(
	shared: TenantSharedConfig,
	judgeVerdictsPath: string,
	judgeActionsPath: string,
	queue: MergeQueue,
	decidedStore: DecidedPrStore,
	state: ServerState,
	llmProviderHolder: LlmProviderHolder,
	github: GitHubClientHolder,
	sink: InstrumentationSink,
): Promise<JudgeRunDeps | undefined> {
	if (shared.judgeConstitution === undefined || shared.judgeMode === "off") return undefined;

	let thresholds;
	try {
		thresholds = resolveJudgeThresholds(process.env, shared.judgeConstitution);
	} catch (err) {
		console.error("Bundle judge disabled: failed to resolve thresholds:", err);
		return undefined;
	}

	const { provider: judgeProvider, description, biasMitigationActive } = resolveJudgeProvider(process.env, llmProviderHolder);
	console.log(
		`Bundle judge (mode: ${shared.judgeMode}) using ${description}` +
			(biasMitigationActive ? "" : " — set QUIRE_JUDGE_MODEL (or a dedicated judge account) for bias mitigation"),
	);

	const verdictStore = await loadJudgeVerdictStore(judgeVerdictsPath);

	let actionDeps: ActionPipelineDeps | undefined;
	if (shared.judgeMode === "auto") {
		const actionStore = await loadJudgeActionStore(judgeActionsPath);
		actionDeps = {
			queue,
			actionStore,
			slack: shared.slack,
			github,
			decidedStore,
			bundles: state.bundles,
			cards: state.cards,
			verifyTimeoutMs: shared.judgeVerifyTimeoutMs,
			...(shared.judgeHealthCheckUrl !== undefined ? { healthCheckUrl: shared.judgeHealthCheckUrl } : {}),
		};
	}

	return {
		mode: shared.judgeMode,
		constitution: shared.judgeConstitution,
		thresholds,
		provider: judgeProvider,
		getQueueState: () => queue.snapshot(),
		getShelfState: () => shelfStateFromMap(state.shelf),
		getDecidedEntries: () => decidedStore.list(),
		verdictStore,
		sink,
		slack: shared.slack,
		cardsMap: state.cards,
		auditSampleRate: shared.judgeAuditSampleRate,
		...(actionDeps !== undefined ? { actionDeps } : {}),
	};
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
	const judgeDecisionLogPath = join(dir, "instrumentation/judge-decisions.ndjson");
	const judgeVerdictsPath = join(dir, "judge-verdicts.json");
	const judgeActionsPath = join(dir, "judge-actions.json");

	const decidedStore = new DecidedPrStore(decidedPrsPath);
	const prCache = new PrEffectCache(prCachePath);
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
		notifyStateChanged,
	);
	await queue.load();

	const instrumentationSink = createNdjsonInstrumentationSink({ gateLogPath, driftScreenLogPath, judgeDecisionLogPath });
	const judgeDeps = await buildJudgeRunDeps(
		shared,
		judgeVerdictsPath,
		judgeActionsPath,
		queue,
		decidedStore,
		state,
		llmProviderHolder,
		clientHolder,
		instrumentationSink,
	);
	const judgeActionDeps = judgeDeps?.actionDeps;
	const pipelineDeps: PipelineDeps = {
		config: shared.pipelineConfig,
		provider: llmProviderHolder,
		analyzer: shared.analyzer,
		auditStore,
		prCache,
		instrumentationSink,
		...(judgeDeps !== undefined ? { judgeDeps } : {}),
	};

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
	router.use("/bundles", gesturesRouter(state, queue, deferLogPath, clientHolder, decidedStore, accountState, shelfPath));
	router.use("/bundles", assignmentsRouter(state));
	router.use("/queue", queueRouter(queue, state, decidedStore, accountState));
	router.use("/shelf", shelfRouter(state, decidedStore, shelfPath));
	router.use("/audit", auditRouter(auditStore));
	router.use(
		"/judge",
		judgeRouter({
			...(judgeDeps?.verdictStore !== undefined ? { verdictStore: judgeDeps.verdictStore } : {}),
			...(judgeDeps?.actionDeps?.actionStore !== undefined ? { actionStore: judgeDeps.actionDeps.actionStore } : {}),
			decidedStore,
		}),
	);
	router.use(
		"/admin",
		adminRouter(state, auditStore, queue, [deferLogPath, gateLogPath, driftScreenLogPath, conflictLogPath], decidedStore, shelfPath),
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
			isInstallationBoundToAnotherTeam: (installationId) => registry.isInstallationBoundToOtherTeam(installationId, teamId),
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
		router,
		...(judgeActionDeps !== undefined ? { judgeActionDeps } : {}),
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
