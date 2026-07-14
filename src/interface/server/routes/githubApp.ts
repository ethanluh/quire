import { Router } from "express";
import { z } from "zod";
import type { InstallationAccountState, InstallationBinding, RepoBinding } from "../../../engine/github/installation.js";
import { saveInstallation, clearInstallation } from "../../../engine/github/installation.js";
import type { AccessibleInstallation, InstallationAccount } from "../../../engine/github/installationClient.js";
import { isInstallationRevoked } from "../../../engine/github/installationClient.js";
import { removeCollaboratorsFromRepo } from "../../../engine/github/collaborators.js";
import type { BuildOctokit, CollaboratorSyncResult } from "../../../engine/github/collaborators.js";
import { withInstallationLock } from "../../../engine/github/installationLock.js";
import type { OAuthDeps } from "../../../engine/github/oauth.js";
import type { RepoSummary } from "../../../engine/github/repos.js";
import { checkDeclaredDirectionConvention, setUpDeclaredDirectionConvention } from "../../../engine/github/repoSetup.js";
import type { UserTokenCache } from "../../../engine/github/userTokenCache.js";
import { refreshUserTokenFromDisk, userTokenPath } from "../../../engine/github/userToken.js";
import { settleWithConcurrency } from "../../../engine/util/concurrency.js";
import { clearRepoFromQueue, enqueueRefresh, InstallationRevokedError, AccountChangedError } from "../refreshRepoQueue.js";
import type { RefreshDeps } from "../refreshRepoQueue.js";
import { validateBody } from "../middleware/validation.js";
import { requireRole } from "../middleware/requireRole.js";
import { mintOrReuseStateCookie, consumeStateCookie } from "../stateCookie.js";
import { accountResultRedirectUrl } from "./account.js";

const SelectRepoSchema = z.object({
	owner: z.string().min(1),
	name: z.string().min(1),
	installationId: z.number().int().positive(),
});

const ConnectInstallationSchema = z.object({
	installationId: z.number().int().positive(),
});

const RepoIdentifierSchema = z.object({
	owner: z.string().min(1),
	name: z.string().min(1),
});

// Deliberately not RepoIdentifierSchema.optional(): express.json() turns a bodyless POST
// (the frontend's own /repos/refresh call site) into `{}`, not `undefined` — `.optional()`
// on a schema whose fields are both required would reject `{}`. Both fields optional here
// means `{}` legitimately parses (as "no repo specified" — refresh everything).
const OptionalRepoIdentifierSchema = z.object({
	owner: z.string().min(1).optional(),
	name: z.string().min(1).optional(),
});

const SettingsSchema = z.object({
	autoMergeOnAccept: z.boolean(),
	flagConflictsForFleet: z.boolean(),
	enableDeepConflictInvestigation: z.boolean(),
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
export interface GithubAppRouterOptions {
	refreshDeps: RefreshDeps;
	appSlug: string;
	listInstallationRepos: (installationId: number, accountLogin: string) => Promise<ReadonlyArray<RepoSummary>>;
	getInstallationAccount: (installationId: number) => Promise<InstallationAccount>;
	secureCookies: boolean;
	userTokenCache: UserTokenCache;
	enrichWithUserToken: (repos: ReadonlyArray<RepoSummary>, accessToken: string) => Promise<ReadonlyArray<RepoSummary>>;
	filterReposForUser: (repos: ReadonlyArray<RepoSummary>, accessToken: string) => Promise<ReadonlyArray<RepoSummary>>;
	canUserAccessRepo: (owner: string, name: string, accessToken: string) => Promise<boolean>;
	listInstallationsForUser: (accessToken: string) => Promise<ReadonlyArray<AccessibleInstallation>>;
	// A team's router can field requests from any of its member logins, so the persisted
	// refresh token lives at a per-login path (mirroring routes/account.ts's own
	// userTokenPath), computed per-request from the signed-in login rather than baked in
	// once at router-construction time the way accountPath/queuePath etc. are.
	dataDir: string;
	oauth: OAuthDeps;
	buildOctokit: BuildOctokit;
	listTeamMemberLogins: (teamId: string) => Promise<ReadonlyArray<string>>;
	teamId: string;
	// Whether the server actually mounted the webhook receiver — surfaced on /repos/select's
	// response so the client's (already-shipped) webhookDisabledReason message can fire.
	webhooksEnabled: boolean;
}

export function githubAppRouter(options: GithubAppRouterOptions): Router {
	const {
		refreshDeps,
		appSlug,
		listInstallationRepos,
		getInstallationAccount,
		secureCookies,
		userTokenCache,
		enrichWithUserToken,
		filterReposForUser,
		canUserAccessRepo,
		listInstallationsForUser,
		dataDir,
		oauth,
		buildOctokit,
		listTeamMemberLogins,
		teamId,
		webhooksEnabled,
	} = options;
	const router = Router();
	const { accountState, accountPath, clientHolder } = refreshDeps;

	// Best-effort, fire-and-forget — same shape as team.ts's syncCollaboratorAdd/Remove: a
	// repo being unbound must never block the unbind response on a GitHub round-trip, and a
	// sync failure (permission not yet approved, GitHub unreachable) must not undo the
	// Quire-side unbind that already succeeded. Revokes every *current* team member's GitHub
	// collaborator access on a repo the moment it's unwatched, since removeTeamMemberAsCollaborator
	// (fired later by an individual leave) only ever loops over repos still bound at that time —
	// it can never retroactively clean up a repo that's already gone from installation.json.
	function revokeAccessOnUnbind(repos: ReadonlyArray<RepoBinding>): void {
		if (repos.length === 0) return;
		listTeamMemberLogins(teamId)
			.then((logins) =>
				Promise.all(
					repos.map((repo) =>
						removeCollaboratorsFromRepo(buildOctokit, repo, logins).then((results) => {
							const failed = results.filter((r): r is Extract<CollaboratorSyncResult, { outcome: "failed" }> => r.outcome === "failed");
							for (const failure of failed) {
								console.error(
									`GitHub collaborator removal failed for ${repo.owner}/${repo.name} on team ${teamId} unbind (${failure.reason}):`,
									failure.error,
								);
							}
						}),
					),
				),
			)
			.catch((err: unknown) => console.error(`Unexpected error revoking GitHub collaborator access on unbind for team ${teamId}:`, err));
	}

	// Upserts one installation's binding into the account-wide state — shared by the
	// GitHub-redirect callback below and the redirect-free /connect route, which both end up
	// binding an installationId the exact same way, just from different sources of trust (a
	// fresh GitHub Setup-URL redirect vs. an installation the signed-in user already had
	// access to). No client to repoint here: clientHolder holds one MultiRepoGitHubClient for
	// the tenant's whole lifetime (see tenant.ts) that resolves the right installation per
	// call, live, off accountState.current.repos — binding a fresh installation never needs
	// this function to touch it.
	function bindInstallation(installationId: number, account: InstallationAccount): InstallationAccountState {
		const binding: InstallationBinding = {
			installationId,
			accountLogin: account.accountLogin,
			accountType: account.accountType,
			boundAt: new Date().toISOString(),
		};
		// Upsert by installationId: re-installing (or re-connecting) replaces that one
		// binding's metadata without touching any other bound installation or any watched repo.
		const current = accountState.current;
		const withoutExisting = current.installations.filter((i) => i.installationId !== installationId);
		const updated: InstallationAccountState = { ...current, installations: [...withoutExisting, binding] };
		accountState.current = updated;
		return updated;
	}

	// Both paths that bind an installation — the GitHub Setup-URL redirect (/install/callback)
	// and the redirect-free /connect — must prove the *signed-in user* actually has access to
	// the installation, not merely that it exists for the App. getInstallationAccount succeeds
	// for ANY installation of this App, and installation ids are small enumerable integers, so
	// without this check any signed-in user could bind another org's installation to their team
	// and then drive its write token (merge/close/revert on that org's PRs). Resolves the user's
	// OAuth token (refreshing from disk on a cache miss, same as the repo picker) and checks it
	// against the installations GitHub says that user can see. Fails closed: no token → denied.
	async function verifyUserInstallationAccess(login: string | undefined, installationId: number): Promise<"granted" | "no-token" | "no-access"> {
		if (login !== undefined && userTokenCache.get(login) === undefined) {
			await refreshUserTokenFromDisk(login, userTokenPath(dataDir, login), oauth, userTokenCache);
		}
		const userToken = login !== undefined ? userTokenCache.get(login) : undefined;
		if (userToken === undefined) return "no-token";
		const accessible = await listInstallationsForUser(userToken);
		return accessible.some((i) => i.installationId === installationId) ? "granted" : "no-access";
	}

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
		const { installations, repos } = accountState.current;
		res.json({
			connected: installations.length > 0,
			installations: installations.map((i) => ({
				installationId: i.installationId,
				accountLogin: i.accountLogin,
				accountType: i.accountType,
				boundAt: i.boundAt,
			})),
			repos,
		});
	});

	// Owner-only: this changes automated-merge policy for every future accept on this repo by
	// any member, so it needs at least as much protection as manually processing the queue.
	// Per-repo (path params), not team-wide — a team can want auto-merge on for one repo and
	// off for another.
	router.post(
		"/repos/:owner/:name/settings",
		requireRole("owner"),
		validateBody(SettingsSchema),
		async (req, res, next) => {
			try {
				const owner = req.params["owner"] ?? "";
				const name = req.params["name"] ?? "";
				const current = accountState.current;
				const target = current.repos.find((r) => r.owner === owner && r.name === name);
				if (target === undefined) {
					res.status(404).json({ error: "That repo isn't currently added" });
					return;
				}
				const { autoMergeOnAccept, flagConflictsForFleet, enableDeepConflictInvestigation } = req.body as z.infer<
					typeof SettingsSchema
				>;
				// Locked like the unbind/disconnect routes below: accountState is shared per-team
				// mutable state, and saveInstallation persists a snapshot — unlocked, a concurrent
				// repo add/bind could land between this mutation and its save and have its change
				// clobbered on disk by this stale snapshot (memory and disk then disagree until
				// the next write). Re-finds the target under the lock for the same reason.
				const updatedRepo = await withInstallationLock(teamId, async (): Promise<RepoBinding | undefined> => {
					const locked = accountState.current;
					const lockedTarget = locked.repos.find((r) => r.owner === owner && r.name === name);
					if (lockedTarget === undefined) return undefined;
					const repo: RepoBinding = { ...lockedTarget, autoMergeOnAccept, flagConflictsForFleet, enableDeepConflictInvestigation };
					const updated: InstallationAccountState = {
						...locked,
						repos: locked.repos.map((r) => (r === lockedTarget ? repo : r)),
					};
					accountState.current = updated;
					await saveInstallation(accountPath, updated);
					return repo;
				});
				if (updatedRepo === undefined) {
					res.status(404).json({ error: "That repo isn't currently added" });
					return;
				}
				res.json(updatedRepo);
			} catch (err) {
				next(err);
			}
		},
	);

	// The nonce lives in a short-lived cookie scoped to the browser doing the install,
	// not a server-wide variable — a second, unrelated install flow (a different admin,
	// a retry) can't clobber this one's pending state the way a shared singleton would.
	// mintOrReuseStateCookie reuses an already-pending nonce from this same browser instead
	// of always minting fresh, so a double-click or a second tab doesn't orphan the first.
	router.post("/install/start", requireRole("owner", "admin"), (req, res) => {
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
	// addressed by this change.
	//
	// Authorization matches /connect (this is the same bind sink, reached via a redirect rather
	// than an AJAX call): the caller must be an owner/admin AND must actually have GitHub access
	// to the installation being bound. The state cookie alone only proves this browser started
	// an install flow — not which installation it may bind — so on its own it would let any
	// signed-in member bind an arbitrary enumerable installation id. Both checks redirect to an
	// error result rather than returning JSON, since the caller is a browser mid-redirect.
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
				res.redirect(accountResultRedirectUrl("error", "the installation request expired or was invalid"));
				return;
			}

			const role = res.locals.membership?.role;
			if (role !== "owner" && role !== "admin") {
				res.redirect(accountResultRedirectUrl("error", "only a team owner or admin can connect a GitHub installation"));
				return;
			}

			const installationId = Number(installationIdRaw);

			const access = await verifyUserInstallationAccess(res.locals.login, installationId);
			if (access !== "granted") {
				res.redirect(
					accountResultRedirectUrl(
						"error",
						access === "no-token"
							? "reconnect your GitHub sign-in and try connecting the installation again"
							: "your GitHub account doesn't have access to that installation",
					),
				);
				return;
			}

			let account: InstallationAccount;
			try {
				account = await getInstallationAccount(installationId);
			} catch (err) {
				if (isInstallationRevoked(err)) {
					res.redirect(accountResultRedirectUrl("error", "the installation was removed or is no longer accessible"));
					return;
				}
				throw err;
			}

			// Locked so the bind and its save are atomic w.r.t. every other accountState
			// mutation (repo select/settings/unbind) — see the settings route above.
			await withInstallationLock(teamId, async () => {
				const updated = bindInstallation(installationId, account);
				await saveInstallation(accountPath, updated);
			});

			res.redirect(accountResultRedirectUrl("connected", undefined));
		} catch (err) {
			next(err);
		}
	});

	// Installations of this App that the signed-in user can already see on GitHub but
	// hasn't bound to this tenant yet — lets Settings offer "Connect" instead of always
	// funneling an already-installed user through the /install/start GitHub redirect.
	// Needs the cached sign-in token (see userTokenCache.ts), so it degrades to "reconnect
	// to check" rather than erroring when that token isn't cached (never signed in this
	// process, or the token expired) and a persisted refresh token can't silently repopulate it.
	router.get("/available-installations", async (_req, res, next) => {
		try {
			const login = res.locals.login;
			if (login !== undefined && userTokenCache.get(login) === undefined) {
				await refreshUserTokenFromDisk(login, userTokenPath(dataDir, login), oauth, userTokenCache);
			}
			const userToken = login !== undefined ? userTokenCache.get(login) : undefined;
			if (userToken === undefined) {
				res.json({ installations: [], needsReconnect: true });
				return;
			}
			const boundIds = new Set(accountState.current.installations.map((i) => i.installationId));
			const accessible = await listInstallationsForUser(userToken);
			res.json({ installations: accessible.filter((i) => !boundIds.has(i.installationId)), needsReconnect: false });
		} catch (err) {
			next(err);
		}
	});

	// Binds an installation the signed-in user already has access to (surfaced by
	// /available-installations above) without sending them through GitHub's install
	// redirect at all — re-verified here via getInstallationAccount rather than trusted
	// from the client, since the browser only ever supplied an installationId.
	router.post("/connect", requireRole("owner", "admin"), validateBody(ConnectInstallationSchema), async (req, res, next) => {
		try {
			const { installationId } = req.body as z.infer<typeof ConnectInstallationSchema>;

			// getInstallationAccount only proves the installation exists *for the App* — it says
			// nothing about whether THIS user may bind it (see verifyUserInstallationAccess). Gate
			// on the same list the picker (/available-installations) is built from: the
			// installations this user can actually see on GitHub. Fails closed when no user token.
			const access = await verifyUserInstallationAccess(res.locals.login, installationId);
			if (access === "no-token") {
				res.status(403).json({ error: "Reconnect your GitHub sign-in to connect an installation." });
				return;
			}
			if (access === "no-access") {
				res.status(403).json({ error: "You don't have access to that GitHub installation." });
				return;
			}

			let account: InstallationAccount;
			try {
				account = await getInstallationAccount(installationId);
			} catch (err) {
				if (isInstallationRevoked(err)) {
					res.status(400).json({ error: "That installation is no longer accessible." });
					return;
				}
				throw err;
			}
			// Locked so the bind and its save are atomic w.r.t. every other accountState
			// mutation — see the settings route above.
			await withInstallationLock(teamId, async () => {
				const updated = bindInstallation(installationId, account);
				await saveInstallation(accountPath, updated);
			});
			res.json({ connected: true, accountLogin: account.accountLogin, accountType: account.accountType });
		} catch (err) {
			next(err);
		}
	});

	router.get("/repos", async (_req, res, next) => {
		try {
			const { installations, repos: watchedRepos } = accountState.current;
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
			// A cache miss here isn't necessarily "never signed in" — it's just as likely the
			// in-memory access token expired mid-session while a still-good refresh token sits
			// on disk, so try that silent path before falling back to unsorted.
			if (login !== undefined && userTokenCache.get(login) === undefined) {
				await refreshUserTokenFromDisk(login, userTokenPath(dataDir, login), oauth, userTokenCache);
			}
			const userToken = login !== undefined ? userTokenCache.get(login) : undefined;

			// The merged list above reflects what the team's installation(s) were granted at
			// GitHub-install time — that's an org/account-level grant, not this specific
			// member's own GitHub access, so a teammate's broader installation must never leak
			// repos this user can't otherwise see. Narrowed to public/owned/shared-with-them
			// before enrichment; no user token to check against means we can't confirm
			// anything beyond "public", so that's the fallback rather than trusting the
			// unfiltered installation-level list.
			const visibleRepos = userToken !== undefined ? await filterReposForUser(repos, userToken) : repos.filter((r) => !r.private);
			const responseRepos = userToken !== undefined ? await enrichWithUserToken(visibleRepos, userToken) : visibleRepos;

			res.json({ repos: responseRepos, selected: watchedRepos, failedAccounts, sortingAvailable: userToken !== undefined });
		} catch (err) {
			next(err);
		}
	});

	// Adds a repo to the team's watch list — a team can watch several concurrently, so this
	// is additive, not a single-slot replace. 409 if the repo is already being watched;
	// re-adding the same (owner, name) through a different installation isn't supported
	// (remove it first via DELETE /repos/:owner/:name, then re-add). Owner/admin only, matching
	// its inverse (DELETE /repos/:owner/:name) — adding a watched repo is a team-wide config
	// change (it starts ingesting that repo for everyone), not a per-member action.
	router.post("/repos/select", requireRole("owner", "admin"), validateBody(SelectRepoSchema), async (req, res, next) => {
		try {
			const { owner, name, installationId } = req.body as z.infer<typeof SelectRepoSchema>;
			const current = accountState.current;
			const targetInstallation = current.installations.find((i) => i.installationId === installationId);
			if (targetInstallation === undefined) {
				res.status(400).json({ error: "Unknown installation" });
				return;
			}
			if (current.repos.some((r) => r.owner === owner && r.name === name)) {
				res.status(409).json({ error: "This repo is already being watched" });
				return;
			}

			// The GET /repos picker already filters to what the requester can personally see,
			// but that's a UX convenience, not a security boundary — this re-checks the same
			// condition server-side so a direct API call can't add a repo the requester has no
			// GitHub access to, just because it happens to be covered by the team's (broader)
			// installation grant. Fails closed: no verifiable user token is treated the same as
			// "can't confirm access," not "assume it's fine."
			const login = res.locals.login;
			if (login !== undefined && userTokenCache.get(login) === undefined) {
				await refreshUserTokenFromDisk(login, userTokenPath(dataDir, login), oauth, userTokenCache);
			}
			const userToken = login !== undefined ? userTokenCache.get(login) : undefined;
			if (userToken === undefined || !(await canUserAccessRepo(owner, name, userToken))) {
				res.status(403).json({ error: "You don't have access to this repository" });
				return;
			}

			const newRepo: RepoBinding = {
				owner,
				name,
				installationId,
				addedAt: new Date().toISOString(),
				addedBy: res.locals.login ?? "unknown",
			};
			// Add BEFORE calling enqueueRefresh (rather than after): refreshRepoQueue resolves
			// "is there an installation bound for this repo" via installationForRepo, which reads
			// accountState.current.repos — with the repo not yet present, that resolution would
			// fail on the very first refresh. Rolled back below if the initial fetch fails, so a
			// failed add never sticks.
			//
			// The add (and the rollback/persist below) run under withInstallationLock: the awaits
			// above (token refresh, canUserAccessRepo) sit between this handler's first read of
			// accountState.current and this write, so two concurrent selects — or a select racing
			// settings/bind/unbind — would otherwise both build from the same stale snapshot and
			// the loser's repo binding would silently vanish (its webhooks and reconcile polls
			// with it). Re-checks the already-watched condition under the lock; the slow
			// enqueueRefresh deliberately stays OUTSIDE the lock so a first fetch can't block
			// every other installation mutation for its duration.
			const added = await withInstallationLock(teamId, async () => {
				const locked = accountState.current;
				if (locked.installations.every((i) => i.installationId !== installationId)) return "unknownInstallation" as const;
				if (locked.repos.some((r) => r.owner === owner && r.name === name)) return "alreadyWatched" as const;
				accountState.current = { ...locked, repos: [...locked.repos, newRepo] };
				return "added" as const;
			});
			if (added === "unknownInstallation") {
				res.status(400).json({ error: "Unknown installation" });
				return;
			}
			if (added === "alreadyWatched") {
				res.status(409).json({ error: "This repo is already being watched" });
				return;
			}
			let summary;
			try {
				summary = await enqueueRefresh(owner, name, refreshDeps);
			} catch (err) {
				await withInstallationLock(teamId, async () => {
					const locked = accountState.current;
					accountState.current = { ...locked, repos: locked.repos.filter((r) => r !== newRepo) };
				});
				throw err;
			}

			// Persists the current locked snapshot (not the pre-refresh one) so a concurrent
			// mutation that landed during the refresh isn't clobbered on disk.
			await withInstallationLock(teamId, () => saveInstallation(accountPath, accountState.current));
			res.json({ added: newRepo, ...summary, ...(webhooksEnabled ? {} : { webhookDisabledReason: "not configured" }) });
		} catch (err) {
			next(err);
		}
	});

	// Removes one repo from the team's watch list without touching its installation binding
	// or any other watched repo — the counterpart to /repos/select's add. Owner/admin only,
	// matching this file's other roster-composition-style changes (settings, disconnect).
	router.delete("/repos/:owner/:name", requireRole("owner", "admin"), async (req, res, next) => {
		try {
			const owner = req.params["owner"] ?? "";
			const name = req.params["name"] ?? "";
			// Locked per-team against team.ts's collaborator-sync reads (see installationLock.ts)
			// so a concurrent join/leave can never read a pre-removal snapshot of `repos` while
			// this write is in flight. The revoke call below deliberately runs AFTER the lock is
			// released — once this write lands, no later-locked read can re-add anyone to the
			// now-unbound repo, so revoking doesn't itself need to hold the lock through its own
			// (potentially slow) GitHub API calls.
			const target = await withInstallationLock(teamId, async () => {
				const current = accountState.current;
				const found = current.repos.find((r) => r.owner === owner && r.name === name);
				if (found === undefined) return undefined;
				const updated: InstallationAccountState = { ...current, repos: current.repos.filter((r) => r !== found) };
				accountState.current = updated;
				clearRepoFromQueue(refreshDeps.state, found);
				await saveInstallation(accountPath, updated);
				return found;
			});
			if (target === undefined) {
				res.status(404).json({ error: "That repo isn't currently added" });
				return;
			}
			revokeAccessOnUnbind([target]);
			res.json({ removed: true });
		} catch (err) {
			next(err);
		}
	});

	router.post("/repos/setup", requireRole("owner", "admin"), validateBody(RepoIdentifierSchema), async (req, res, next) => {
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

	// Read-only counterpart to /repos/setup — lets the client check whether the setup PR is
	// needed before asking the user to confirm opening one.
	router.post("/repos/setup-status", requireRole("owner", "admin"), validateBody(RepoIdentifierSchema), async (req, res, next) => {
		try {
			if (accountState.current.installations.length === 0) {
				res.status(400).json({ error: "Install the GitHub App first" });
				return;
			}
			const { owner, name } = req.body as z.infer<typeof RepoIdentifierSchema>;
			const alreadySetUp = await checkDeclaredDirectionConvention(clientHolder, owner, name);
			res.json({ alreadySetUp });
		} catch (err) {
			next(err);
		}
	});

	// Manual override for the automatic cross-tenant setup-rerun timer (index.ts) — lets an owner
	// force every repo this team currently watches to rerun setup right now, without waiting for
	// the next tick. setUpDeclaredDirectionConvention() is a no-op per repo unless something
	// actually drifted, so this is safe to call repeatedly. Settled independently per repo (not
	// Promise.all), same reasoning as /repos/refresh below.
	router.post("/repos/setup-all", requireRole("owner", "admin"), async (_req, res, next) => {
		try {
			if (accountState.current.installations.length === 0) {
				res.status(400).json({ error: "Install the GitHub App first" });
				return;
			}
			const repos = accountState.current.repos;
			if (repos.length === 0) {
				res.json({ ranSetup: false });
				return;
			}
			const results = await Promise.allSettled(repos.map((repo) => setUpDeclaredDirectionConvention(clientHolder, repo.owner, repo.name)));
			res.json({
				ranSetup: true,
				repos: repos.map((repo, i) => {
					const result = results[i];
					if (result?.status === "fulfilled") {
						return { owner: repo.owner, name: repo.name, ok: true, result: result.value };
					}
					console.error(`Declared-direction setup rerun failed for team ${teamId} (${repo.owner}/${repo.name}):`, result?.reason);
					return { owner: repo.owner, name: repo.name, ok: false };
				}),
			});
		} catch (err) {
			next(err);
		}
	});

	// A cheap, no-bookkeeping refresh — with a body, refreshes just that one repo; with none
	// (the frontend's every-page-load/reload call, from before a team could watch more than
	// one), refreshes every repo the team currently watches. Settled independently per repo
	// (not Promise.all) so one repo hitting AccountChangedError/a transient error can't sink
	// the others' refresh in the same call.
	router.post("/repos/refresh", validateBody(OptionalRepoIdentifierSchema), async (req, res, next) => {
		try {
			const target = req.body as z.infer<typeof OptionalRepoIdentifierSchema>;
			const repos =
				target.owner !== undefined && target.name !== undefined
					? accountState.current.repos.filter((r) => r.owner === target.owner && r.name === target.name)
					: accountState.current.repos;
			if (repos.length === 0) {
				res.json({ refreshed: false });
				return;
			}
			const results = await Promise.allSettled(repos.map((repo) => enqueueRefresh(repo.owner, repo.name, refreshDeps)));
			for (const [i, result] of results.entries()) {
				if (result.status !== "rejected") continue;
				const repo = repos[i];
				const err: unknown = result.reason;
				if (err instanceof InstallationRevokedError) {
					console.warn(`Repo refresh paused for team ${teamId} (${repo?.owner}/${repo?.name}): ${err.message}`);
				} else if (err instanceof AccountChangedError) {
					console.warn(`Repo refresh for team ${teamId} (${repo?.owner}/${repo?.name}) aborted: ${err.message}`);
				} else {
					console.error(`Repo refresh failed for team ${teamId} (${repo?.owner}/${repo?.name}):`, err);
				}
			}
			res.json({
				refreshed: true,
				repos: repos.map((repo, i) => ({ owner: repo.owner, name: repo.name, ok: results[i]?.status === "fulfilled" })),
			});
		} catch (err) {
			next(err);
		}
	});

	// Unbinds exactly one installation — the underlying installation on GitHub's side is
	// untouched (an org admin manages that from GitHub's own App-installation settings, not
	// from here). A disconnect can orphan several watched repos at once now (every repo bound
	// through this installation, not just a single "active" one) — each is torn down the same
	// way /repos/:owner/:name DELETE tears down one.
	router.post("/disconnect/:installationId", requireRole("owner", "admin"), async (req, res, next) => {
		try {
			const installationId = Number(req.params["installationId"]);
			if (!Number.isInteger(installationId) || installationId <= 0) {
				res.status(400).json({ error: "Invalid installation id" });
				return;
			}
			// Locked per-team against team.ts's collaborator-sync reads — see the DELETE
			// /repos/:owner/:name handler above for why the revoke call itself runs after the
			// lock is released rather than inside it.
			const { remaining, orphanedRepos } = await withInstallationLock(teamId, async () => {
				const current = accountState.current;
				const remaining = current.installations.filter((i) => i.installationId !== installationId);
				const orphanedRepos = current.repos.filter((r) => r.installationId === installationId);
				const remainingRepos = current.repos.filter((r) => r.installationId !== installationId);

				const updated: InstallationAccountState =
					remaining.length === 0 ? { installations: [], repos: [] } : { installations: remaining, repos: remainingRepos };
				accountState.current = updated;
				for (const repo of orphanedRepos) {
					clearRepoFromQueue(refreshDeps.state, repo);
				}
				// Once the last installation is gone, tear down the file the same way disconnect-all
				// does (rather than leaving behind a near-empty `{"installations":[],"repos":[]}`) —
				// functionally equivalent on next load, but avoids two disconnect routes disagreeing
				// about what "no installations bound" looks like on disk.
				if (remaining.length === 0) {
					repoListCache.clear();
					await clearInstallation(accountPath);
				} else {
					repoListCache.delete(installationId);
					await saveInstallation(accountPath, updated);
				}
				return { remaining, orphanedRepos };
			});
			revokeAccessOnUnbind(orphanedRepos);
			res.json({ disconnected: installationId, remaining: remaining.length, reposRemoved: orphanedRepos.length });
		} catch (err) {
			next(err);
		}
	});

	// The "start over" nuke — wipes every bound installation, every watched repo, and the
	// persisted file itself, distinct from unbinding one installation at a time above.
	router.post("/disconnect-all", requireRole("owner", "admin"), async (_req, res, next) => {
		try {
			// Locked per-team against team.ts's collaborator-sync reads — see the DELETE
			// /repos/:owner/:name handler above for why the revoke call itself runs after the
			// lock is released rather than inside it.
			const previousRepos = await withInstallationLock(teamId, async () => {
				const previousRepos = accountState.current.repos;
				accountState.current = { installations: [], repos: [] };
				repoListCache.clear();
				for (const repo of previousRepos) {
					clearRepoFromQueue(refreshDeps.state, repo);
				}
				await clearInstallation(accountPath);
				return previousRepos;
			});
			revokeAccessOnUnbind(previousRepos);
			res.json({ connected: false });
		} catch (err) {
			next(err);
		}
	});

	return router;
}
