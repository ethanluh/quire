import { Router } from "express";
import { z } from "zod";
import type { InstallationAccountState, InstallationBinding } from "../../../engine/github/installation.js";
import { saveInstallation, clearInstallation } from "../../../engine/github/installation.js";
import type { InstallationAccount } from "../../../engine/github/installationClient.js";
import { isInstallationRevoked } from "../../../engine/github/installationClient.js";
import { StubGitHubClient } from "../../../engine/github/stubClient.js";
import type { GitHubClient } from "../../../engine/github/client.js";
import type { RepoSummary } from "../../../engine/github/repos.js";
import { setUpDeclaredDirectionConvention } from "../../../engine/github/repoSetup.js";
import type { UserTokenCache } from "../../../engine/github/userTokenCache.js";
import { settleWithConcurrency } from "../../../engine/util/concurrency.js";
import { activeInstallation } from "../accountState.js";
import { clearRepoFromQueue, enqueueRefresh, AccountChangedError } from "../refreshRepoQueue.js";
import type { RefreshDeps } from "../refreshRepoQueue.js";
import { validateBody } from "../middleware/validation.js";
import { mintOrReuseStateCookie, consumeStateCookie } from "../stateCookie.js";

const SelectRepoSchema = z.object({
	owner: z.string().min(1),
	name: z.string().min(1),
	installationId: z.number().int().positive(),
});

const RepoIdentifierSchema = z.object({
	owner: z.string().min(1),
	name: z.string().min(1),
});

const SettingsSchema = z.object({
	autoMergeOnAccept: z.boolean(),
});

const INSTALL_STATE_COOKIE_NAME = "quire_install_state";
const INSTALL_STATE_TTL_MS = 10 * 60 * 1000;
const REPO_LIST_CACHE_TTL_MS = 30 * 1000;
const INSTALLATION_LIST_CONCURRENCY = 4;

// Everything installation-shaped: binding GitHub App installations to Quire (an operator
// may bind several — their personal account plus N orgs), listing the repos they cover,
// and picking which one to actively watch. Deliberately separate from account.ts (pure
// login/session) — the two used to be one router because a personal OAuth token served as
// both identity and API credential; an installation is a structurally different kind of
// grant (org/repo-level, not person-level), with its own state machine and its own
// callback shape (a Setup URL redirect, not an OAuth callback).
export function githubAppRouter(
	refreshDeps: RefreshDeps,
	appSlug: string,
	buildClient: (installationId: number) => GitHubClient,
	listInstallationRepos: (installationId: number, accountLogin: string) => Promise<ReadonlyArray<RepoSummary>>,
	getInstallationAccount: (installationId: number) => Promise<InstallationAccount>,
	secureCookies: boolean,
	userTokenCache: UserTokenCache,
	enrichWithUserToken: (repos: ReadonlyArray<RepoSummary>, accessToken: string) => Promise<ReadonlyArray<RepoSummary>>,
): Router {
	const router = Router();
	const { accountState, accountPath, clientHolder } = refreshDeps;

	interface RepoListCacheEntry {
		expiresAt: number;
		repos: Promise<ReadonlyArray<RepoSummary>>;
	}
	// Keyed per-installation so binding/disconnecting one installation doesn't invalidate
	// the others' still-fresh cached lists. Caches the in-flight promise itself (not just the
	// settled value) so concurrent /repos calls share one upstream fetch per installation
	// instead of each firing their own.
	const repoListCache = new Map<number, RepoListCacheEntry>();

	function getReposCached(installation: InstallationBinding): Promise<ReadonlyArray<RepoSummary>> {
		const cached = repoListCache.get(installation.installationId);
		if (cached !== undefined && Date.now() < cached.expiresAt) return cached.repos;

		const repos = listInstallationRepos(installation.installationId, installation.accountLogin);
		repos.then(
			() => {
				const entry = repoListCache.get(installation.installationId);
				if (entry !== undefined) entry.expiresAt = Date.now() + REPO_LIST_CACHE_TTL_MS;
			},
			() => repoListCache.delete(installation.installationId),
		);
		repoListCache.set(installation.installationId, { expiresAt: Number.POSITIVE_INFINITY, repos });
		return repos;
	}

	router.get("/status", (_req, res) => {
		const { installations, selectedRepo, autoMergeOnAccept } = accountState.current;
		res.json({
			connected: installations.length > 0,
			installations: installations.map((i) => ({
				installationId: i.installationId,
				accountLogin: i.accountLogin,
				accountType: i.accountType,
				boundAt: i.boundAt,
			})),
			selectedRepo,
			autoMergeOnAccept: autoMergeOnAccept ?? false,
		});
	});

	router.post("/settings", validateBody(SettingsSchema), async (req, res, next) => {
		try {
			const current = accountState.current;
			if (current.installations.length === 0) {
				res.status(400).json({ error: "Install the GitHub App first" });
				return;
			}
			const { autoMergeOnAccept } = req.body as z.infer<typeof SettingsSchema>;
			const updated: InstallationAccountState = { ...current, autoMergeOnAccept };
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
			// Upsert by installationId: re-installing (GitHub can redirect back through this
			// same callback for an "update" action) replaces that one binding's metadata
			// without touching any other bound installation or the current selection.
			const current = accountState.current;
			const withoutExisting = current.installations.filter((i) => i.installationId !== installationId);
			const updated: InstallationAccountState = { ...current, installations: [...withoutExisting, binding] };
			accountState.current = updated;

			// Only repoint the shared client if this (re)install happens to be the one
			// currently backing the active selection — a fresh, unrelated installation
			// shouldn't disturb whatever's already being watched.
			if (activeInstallation(updated)?.installationId === installationId) {
				clientHolder.setClient(buildClient(installationId));
			}
			await saveInstallation(accountPath, updated);

			res.redirect("/?account=connected");
		} catch (err) {
			next(err);
		}
	});

	router.get("/repos", async (_req, res, next) => {
		try {
			const { installations, selectedRepo } = accountState.current;
			if (installations.length === 0) {
				res.status(400).json({ error: "Install the GitHub App first" });
				return;
			}

			const results = await settleWithConcurrency(installations, INSTALLATION_LIST_CONCURRENCY, getReposCached);

			const repos: RepoSummary[] = [];
			const failedAccounts: string[] = [];
			installations.forEach((installation, i) => {
				const result = results[i];
				if (result?.status === "fulfilled") repos.push(...result.value);
				else failedAccounts.push(installation.accountLogin);
			});

			// Starred/pinned status is a per-request enrichment, not part of the cached
			// per-installation repos payload — it needs the signed-in user's own token (an
			// installation client has no "viewer"), and degrades to the plain merged list,
			// unsorted, when there's no cached token (never signed in this process, or it
			// expired). Applied once over the merged, concatenated list from every
			// installation, after the multi-installation fan-out above.
			const login = res.locals.login;
			const userToken = login !== undefined ? userTokenCache.get(login) : undefined;
			const responseRepos = userToken !== undefined ? await enrichWithUserToken(repos, userToken) : repos;

			res.json({ repos: responseRepos, selected: selectedRepo, failedAccounts });
		} catch (err) {
			next(err);
		}
	});

	router.post("/repos/select", validateBody(SelectRepoSchema), async (req, res, next) => {
		try {
			const { owner, name, installationId } = req.body as z.infer<typeof SelectRepoSchema>;
			const previousState = accountState.current;
			const targetInstallation = previousState.installations.find((i) => i.installationId === installationId);
			if (targetInstallation === undefined) {
				res.status(400).json({ error: "Unknown installation" });
				return;
			}
			const previousRepo = previousState.selectedRepo;
			const previousClient = clientHolder.getClient();

			// Repoint the shared client BEFORE enqueueing the refresh, since enqueueRefresh
			// reads through it — this is the one steady-state place "which installation is
			// active" changes.
			clientHolder.setClient(buildClient(installationId));

			// Set the new selection BEFORE calling enqueueRefresh (rather than after, like the
			// old single-installation flow could get away with): refreshRepoQueue now resolves
			// "is there an active installation for this call" via activeInstallation(), which
			// reads selectedRepo — with nothing selected yet, that resolution would fail on the
			// very first selection. Rolled back below (only if nothing else changed it meanwhile)
			// if the initial fetch fails, so a failed selection never sticks.
			const updated: InstallationAccountState = { ...previousState, selectedRepo: { owner, name, installationId } };
			accountState.current = updated;
			let summary;
			try {
				summary = await enqueueRefresh(owner, name, refreshDeps);
			} catch (err) {
				if (accountState.current === updated) accountState.current = previousState;
				clientHolder.setClient(previousClient);
				throw err;
			}

			// Only clear the old repo's queue state once the new selection has actually
			// succeeded — clearing it upfront would lose that repo's bundles/cards for good if
			// enqueueRefresh then failed and the selection rolled back.
			clearRepoFromQueue(refreshDeps.state, previousRepo);
			await saveInstallation(accountPath, updated);

			res.json({ selected: updated.selectedRepo, ...summary });
		} catch (err) {
			next(err);
		}
	});

	router.post("/repos/setup", validateBody(RepoIdentifierSchema), async (req, res, next) => {
		try {
			if (accountState.current.installations.length === 0) {
				res.status(400).json({ error: "Install the GitHub App first" });
				return;
			}
			const { owner, name } = req.body as z.infer<typeof RepoIdentifierSchema>;
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
			const repo = accountState.current.selectedRepo;
			if (repo === undefined) {
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

	// Unbinds exactly one installation — the underlying installation on GitHub's side is
	// untouched (an org admin manages that from GitHub's own App-installation settings, not
	// from here). If it was backing the active selection, the selection is cleared too,
	// since no bound installation can serve that repo anymore.
	router.post("/disconnect/:installationId", async (req, res, next) => {
		try {
			const installationId = Number(req.params["installationId"]);
			if (!Number.isInteger(installationId) || installationId <= 0) {
				res.status(400).json({ error: "Invalid installation id" });
				return;
			}
			const current = accountState.current;
			const remaining = current.installations.filter((i) => i.installationId !== installationId);
			const wasActive = current.selectedRepo?.installationId === installationId;
			const nextSelectedRepo = wasActive ? undefined : current.selectedRepo;

			const updated: InstallationAccountState =
				remaining.length === 0
					? { installations: [] }
					: {
							installations: remaining,
							...(nextSelectedRepo !== undefined ? { selectedRepo: nextSelectedRepo } : {}),
							...(current.autoMergeOnAccept !== undefined ? { autoMergeOnAccept: current.autoMergeOnAccept } : {}),
						};
			accountState.current = updated;
			if (wasActive) {
				clearRepoFromQueue(refreshDeps.state, current.selectedRepo);
				clientHolder.setClient(new StubGitHubClient());
			}
			// Once the last installation is gone, tear down the file the same way disconnect-all
			// does (rather than leaving behind a near-empty `{"installations":[]}`) — functionally
			// equivalent on next load, but avoids two disconnect routes disagreeing about what "no
			// installations bound" looks like on disk.
			if (remaining.length === 0) {
				repoListCache.clear();
				await clearInstallation(accountPath);
			} else {
				repoListCache.delete(installationId);
				await saveInstallation(accountPath, updated);
			}
			res.json({ disconnected: installationId, remaining: remaining.length });
		} catch (err) {
			next(err);
		}
	});

	// The "start over" nuke — wipes every bound installation and the persisted file itself,
	// distinct from unbinding one at a time via /disconnect/:installationId above.
	router.post("/disconnect-all", async (_req, res, next) => {
		try {
			const previousRepo = accountState.current.selectedRepo;
			accountState.current = { installations: [] };
			repoListCache.clear();
			clearRepoFromQueue(refreshDeps.state, previousRepo);
			clientHolder.setClient(new StubGitHubClient());
			await clearInstallation(accountPath);
			res.json({ connected: false });
		} catch (err) {
			next(err);
		}
	});

	return router;
}
