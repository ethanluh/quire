import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { Router } from "express";
import type { GitHubClient } from "../../engine/github/client.js";
import { GitHubClientHolder } from "../../engine/github/clientHolder.js";
import { StubGitHubClient } from "../../engine/github/stubClient.js";
import { loadInstallation } from "../../engine/github/installation.js";
import { buildInstallationClient, buildInstallationOctokit, getInstallationAccount } from "../../engine/github/installationClient.js";
import type { GitHubAppConfig } from "../../engine/github/installationClient.js";
import { listInstallationRepositories } from "../../engine/github/repos.js";
import { MergeQueue } from "../../engine/queue/mergeQueue.js";
import { DecidedPrStore } from "../../engine/queue/decidedPrStore.js";
import { PrEffectCache } from "../../engine/cache/prCache.js";
import { AuditStore, loadAuditStore } from "../../engine/gate/auditStore.js";
import { LlmProviderHolder } from "../../engine/drift/effectList/providerHolder.js";
import type { StaticAnalyzer } from "../../engine/drift/footprint/analyzer.js";
import { loadAccount as loadLlmAccount } from "../../engine/llm/account.js";
import { createNdjsonInstrumentationSink } from "../../engine/instrumentation/logger.js";
import type { PipelineConfig } from "../../engine/pipeline/pipeline.js";
import { createAccountState } from "./accountState.js";
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

async function loadTenant(teamId: string, shared: TenantSharedConfig): Promise<TenantContext> {
	const dir = join(shared.dataDir, "teams", teamId);
	const installationPath = join(dir, "installation.json");
	const llmAccountPath = join(dir, "llm-account.json");
	const queuePath = join(dir, "queue.json");
	const decidedPrsPath = join(dir, "decided-prs.json");
	const prCachePath = join(dir, "pr-cache.json");
	const deferLogPath = join(dir, "instrumentation/defers.ndjson");
	const gateLogPath = join(dir, "instrumentation/gate-decisions.ndjson");
	const driftScreenLogPath = join(dir, "instrumentation/drift-screen.ndjson");
	const auditLogPath = join(dir, "instrumentation/audit.ndjson");

	const installationBinding = await loadInstallation(installationPath);
	const accountState = createAccountState(installationBinding);

	const decidedStore = new DecidedPrStore(decidedPrsPath);
	await decidedStore.load();

	const prCache = new PrEffectCache(prCachePath);
	await prCache.load();

	const auditStore = await loadAuditStore(auditLogPath);

	let initialClient: GitHubClient;
	if (installationBinding !== undefined) {
		initialClient = buildInstallationClient(shared.appConfig, installationBinding.installationId);
	} else {
		initialClient = new StubGitHubClient();
	}
	const clientHolder = new GitHubClientHolder(initialClient);
	const queue = new MergeQueue(queuePath, clientHolder);
	await queue.load();

	const connectedLlmAccount = await loadLlmAccount(llmAccountPath);
	const llmAccountState = createLlmAccountState(connectedLlmAccount);
	const { provider: initialLlmProvider } =
		connectedLlmAccount !== undefined ? buildLlmProviderFromAccount(connectedLlmAccount) : shared.resolveDefaultLlmProvider();
	const llmProviderHolder = new LlmProviderHolder(initialLlmProvider);

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
	router.use("/admin", adminRouter(state, auditStore, queue, [deferLogPath, gateLogPath, driftScreenLogPath], decidedStore));
	router.use(
		"/account/github",
		githubAppRouter(
			refreshDeps,
			shared.appSlug,
			shared.appConfig,
			(installationId) => listInstallationRepositories(buildInstallationOctokit(shared.appConfig, installationId)),
			(installationId) => getInstallationAccount(shared.appConfig, installationId),
			shared.isProduction,
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

		const promise = loadTenant(key, this.shared).then((tenant) => {
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

	// A linear scan over (typically a handful of) tenants instead of a maintained reverse
	// index — accountState.current is the one place installationId already lives, kept up
	// to date by githubApp.ts's existing routes, so there's nothing else that could drift
	// out of sync with it.
	findByInstallationId(installationId: number): TenantContext | undefined {
		for (const tenant of this.tenants.values()) {
			if (tenant.accountState.current?.installationId === installationId) return tenant;
		}
		return undefined;
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
