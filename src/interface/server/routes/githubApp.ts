import { Router } from "express";
import { z } from "zod";
import type { InstallationBinding } from "../../../engine/github/installation.js";
import { saveInstallation, clearInstallation } from "../../../engine/github/installation.js";
import type { GitHubAppConfig, InstallationAccount } from "../../../engine/github/installationClient.js";
import { buildInstallationClient, isInstallationRevoked } from "../../../engine/github/installationClient.js";
import type { RepoSummary } from "../../../engine/github/repos.js";
import { setUpDeclaredDirectionConvention } from "../../../engine/github/repoSetup.js";
import type { UserTokenCache } from "../../../engine/github/userTokenCache.js";
import { clearRepoFromQueue, enqueueRefresh, AccountChangedError } from "../refreshRepoQueue.js";
import type { RefreshDeps } from "../refreshRepoQueue.js";
import { validateBody } from "../middleware/validation.js";
import { mintOrReuseStateCookie, consumeStateCookie } from "../stateCookie.js";

const SelectRepoSchema = z.object({
	owner: z.string().min(1),
	name: z.string().min(1),
});

const SettingsSchema = z.object({
	autoMergeOnAccept: z.boolean(),
});

const INSTALL_STATE_COOKIE_NAME = "quire_install_state";
const INSTALL_STATE_TTL_MS = 10 * 60 * 1000;
const REPO_LIST_CACHE_TTL_MS = 30 * 1000;

// Everything installation-shaped: binding a GitHub App installation to Quire, listing the
// repos it covers, and picking which one to actively watch. Deliberately separate from
// account.ts (pure login/session) — the two used to be one router because a personal
// OAuth token served as both identity and API credential; an installation is a
// structurally different kind of grant (org/repo-level, not person-level), with its own
// state machine and its own callback shape (a Setup URL redirect, not an OAuth callback).
export function githubAppRouter(
	refreshDeps: RefreshDeps,
	appSlug: string,
	appConfig: GitHubAppConfig,
	listInstallationRepos: (installationId: number) => Promise<ReadonlyArray<RepoSummary>>,
	getInstallationAccount: (installationId: number) => Promise<InstallationAccount>,
	secureCookies: boolean,
	userTokenCache: UserTokenCache,
	enrichWithUserToken: (repos: ReadonlyArray<RepoSummary>, accessToken: string) => Promise<ReadonlyArray<RepoSummary>>,
	// Multi-tenant only: lets this team's router refuse to bind an installation another
	// team already has bound, so findByInstallationId's lookup in tenant.ts never has to
	// pick a winner between two teams claiming the same installation. Undefined in
	// single-tenant contexts/tests, where there's only ever one team to begin with.
	isInstallationBoundToAnotherTeam?: (installationId: number) => boolean,
): Router {
	const router = Router();
	const { accountState, accountPath, clientHolder } = refreshDeps;

	interface RepoListCacheEntry {
		installationId: number;
		expiresAt: number;
		repos: ReadonlyArray<RepoSummary>;
	}
	let repoListCache: RepoListCacheEntry | undefined;

	router.get("/status", (_req, res) => {
		const binding = accountState.current;
		if (binding === undefined) {
			res.json({ connected: false });
			return;
		}
		res.json({
			connected: true,
			accountLogin: binding.accountLogin,
			accountType: binding.accountType,
			boundAt: binding.boundAt,
			selectedRepo: binding.selectedRepo,
			autoMergeOnAccept: binding.autoMergeOnAccept ?? false,
		});
	});

	router.post("/settings", validateBody(SettingsSchema), async (req, res, next) => {
		try {
			const current = accountState.current;
			if (current === undefined) {
				res.status(400).json({ error: "Install the GitHub App first" });
				return;
			}
			const { autoMergeOnAccept } = req.body as z.infer<typeof SettingsSchema>;
			const updated: InstallationBinding = { ...current, autoMergeOnAccept };
			accountState.current = updated;
			await saveInstallation(accountPath, updated);
			res.json({ autoMergeOnAccept });
		} catch (err) {
			next(err);
		}
	});

	// The nonce lives in a short-lived cookie scoped to the browser doing the install,
	// not a server-wide variable — a second, unrelated install flow (a different admin,
	// a retry) can't clobber this one's pending state the way a shared singleton would.
	// mintOrReuseStateCookie reuses an already-pending nonce from this same browser instead
	// of always minting fresh, so a double-click or a second tab doesn't orphan the first.
	router.post("/install/start", (req, res) => {
		const state = mintOrReuseStateCookie(req, res, INSTALL_STATE_COOKIE_NAME, INSTALL_STATE_TTL_MS, secureCookies);
		const params = new URLSearchParams({ state });
		res.json({ installUrl: `https://github.com/apps/${appSlug}/installations/new?${params.toString()}` });
	});

	// The App's Setup URL — GitHub redirects here after the user installs (or updates)
	// the App, carrying installation_id, setup_action, and Quire's own state. This router is
	// mounted after the global session middleware (see index.ts), so — despite this being a
	// GitHub-initiated redirect, not a user-initiated one — it DOES require a currently valid
	// session cookie to reach this handler at all. If that cookie expires or is cleared while
	// the GitHub App-installation UI is open, the callback 401s before this code runs and the
	// installation (already completed on GitHub's side) never gets bound here. Known gap, not
	// addressed by this change; fixing it means deciding how an install-callback route can be
	// authenticated without a fresh session in a still-single-tenant, pre-multi-user Quire.
	router.get("/install/callback", async (req, res, next) => {
		try {
			const { installation_id: installationIdRaw, state: returnedState } = req.query;
			const pendingState = consumeStateCookie(req, res, INSTALL_STATE_COOKIE_NAME);

			if (
				pendingState === undefined ||
				typeof installationIdRaw !== "string" ||
				typeof returnedState !== "string" ||
				returnedState !== pendingState
			) {
				res.redirect("/?account=error&reason=the+installation+request+expired+or+was+invalid");
				return;
			}

			const installationId = Number(installationIdRaw);

			if (isInstallationBoundToAnotherTeam?.(installationId) === true) {
				res.redirect("/?account=error&reason=this+GitHub+installation+is+already+connected+to+a+different+Quire+team");
				return;
			}

			let account: InstallationAccount;
			try {
				account = await getInstallationAccount(installationId);
			} catch (err) {
				if (isInstallationRevoked(err)) {
					res.redirect("/?account=error&reason=the+installation+was+removed+or+is+no+longer+accessible");
					return;
				}
				throw err;
			}

			const binding: InstallationBinding = {
				installationId,
				accountLogin: account.accountLogin,
				accountType: account.accountType,
				boundAt: new Date().toISOString(),
			};
			accountState.current = binding;
			clientHolder.setClient(buildInstallationClient(appConfig, installationId));
			await saveInstallation(accountPath, binding);

			res.redirect("/?account=connected");
		} catch (err) {
			next(err);
		}
	});

	router.get("/repos", async (_req, res, next) => {
		try {
			const binding = accountState.current;
			if (binding === undefined) {
				res.status(400).json({ error: "Install the GitHub App first" });
				return;
			}
			const cached = repoListCache;
			const repos =
				cached !== undefined && cached.installationId === binding.installationId && Date.now() < cached.expiresAt
					? cached.repos
					: await listInstallationRepos(binding.installationId);
			if (cached === undefined || repos !== cached.repos) {
				repoListCache = { installationId: binding.installationId, expiresAt: Date.now() + REPO_LIST_CACHE_TTL_MS, repos };
			}

			// Starred/pinned status is a per-request enrichment, not part of the cached
			// installation-repos payload — it needs the signed-in user's own token (an
			// installation client has no "viewer"), and degrades to the plain list, unsorted,
			// when there's no cached token (never signed in this process, or it expired).
			const login = res.locals.login;
			const userToken = login !== undefined ? userTokenCache.get(login) : undefined;
			const responseRepos = userToken !== undefined ? await enrichWithUserToken(repos, userToken) : repos;

			res.json({ repos: responseRepos, selected: binding.selectedRepo });
		} catch (err) {
			next(err);
		}
	});

	router.post("/repos/select", validateBody(SelectRepoSchema), async (req, res, next) => {
		try {
			const binding = accountState.current;
			if (binding === undefined) {
				res.status(400).json({ error: "Install the GitHub App first" });
				return;
			}
			const { owner, name } = req.body as z.infer<typeof SelectRepoSchema>;
			const previousRepo = binding.selectedRepo;

			clearRepoFromQueue(refreshDeps.state, previousRepo);
			const summary = await enqueueRefresh(owner, name, refreshDeps);

			const current = accountState.current;
			if (current === undefined) {
				throw new Error("Installation was disconnected mid-request");
			}
			const updated: InstallationBinding = { ...current, selectedRepo: { owner, name } };
			accountState.current = updated;
			await saveInstallation(accountPath, updated);

			res.json({ selected: updated.selectedRepo, ...summary });
		} catch (err) {
			next(err);
		}
	});

	router.post("/repos/setup", validateBody(SelectRepoSchema), async (req, res, next) => {
		try {
			const binding = accountState.current;
			if (binding === undefined) {
				res.status(400).json({ error: "Install the GitHub App first" });
				return;
			}
			const { owner, name } = req.body as z.infer<typeof SelectRepoSchema>;
			const result = await setUpDeclaredDirectionConvention(clientHolder, owner, name);
			res.json(result);
		} catch (err) {
			next(err);
		}
	});

	// A cheap, no-bookkeeping refresh of whatever repo is already selected — reused by the
	// frontend on every page load/reload.
	router.post("/repos/refresh", async (_req, res, next) => {
		try {
			const binding = accountState.current;
			const repo = binding?.selectedRepo;
			if (binding === undefined || repo === undefined) {
				res.json({ refreshed: false });
				return;
			}
			const summary = await enqueueRefresh(repo.owner, repo.name, refreshDeps);
			res.json({ refreshed: true, repo, ...summary });
		} catch (err) {
			if (err instanceof AccountChangedError) {
				res.json({ refreshed: false });
				return;
			}
			next(err);
		}
	});

	// "Disconnect" here means unbinding — there is no token to revoke; the underlying
	// installation on GitHub's side is untouched (an org admin manages that from GitHub's
	// own App-installation settings, not from here).
	router.post("/disconnect", async (_req, res, next) => {
		try {
			accountState.current = undefined;
			await clearInstallation(accountPath);
			res.json({ connected: false });
		} catch (err) {
			next(err);
		}
	});

	return router;
}
