import { randomBytes } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import type { InstallationBinding } from "../../../engine/github/installation.js";
import { saveInstallation, clearInstallation } from "../../../engine/github/installation.js";
import type { GitHubAppConfig } from "../../../engine/github/installationClient.js";
import { buildInstallationClient } from "../../../engine/github/installationClient.js";
import type { RepoSummary } from "../../../engine/github/repos.js";
import { clearRepoFromQueue, enqueueRefresh, AccountChangedError } from "../refreshRepoQueue.js";
import type { RefreshDeps } from "../refreshRepoQueue.js";
import { validateBody } from "../middleware/validation.js";

const SelectRepoSchema = z.object({
	owner: z.string().min(1),
	name: z.string().min(1),
});

const SettingsSchema = z.object({
	autoMergeOnAccept: z.boolean(),
});

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
): Router {
	const router = Router();
	const { accountState, accountPath, clientHolder } = refreshDeps;

	interface PendingInstall {
		state: string;
		expiresAt: number;
	}
	let pendingInstall: PendingInstall | undefined;

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

	router.post("/install/start", (_req, res) => {
		// Idempotent while a flow is still pending, same rationale as account.ts's OAuth
		// nonce: a double-click or a second tab reuses the pending nonce instead of
		// orphaning the first flow's eventual Setup URL callback.
		if (pendingInstall === undefined || Date.now() >= pendingInstall.expiresAt) {
			pendingInstall = { state: randomBytes(32).toString("hex"), expiresAt: Date.now() + INSTALL_STATE_TTL_MS };
		}
		const params = new URLSearchParams({ state: pendingInstall.state });
		res.json({ installUrl: `https://github.com/apps/${appSlug}/installations/new?${params.toString()}` });
	});

	// The App's Setup URL — GitHub redirects here after the user installs (or updates)
	// the App, carrying installation_id, setup_action, and Quire's own state. Not gated
	// behind requireSession's normal flow the way data routes are: reachable the moment
	// GitHub redirects back, since the browser's session cookie may have expired mid-flow
	// and there is nothing tenant-scoped to bind to yet in this single-global-instance
	// version (a later stage carries the initiating tenant inside `state` once
	// multi-tenancy exists).
	router.get("/install/callback", async (req, res, next) => {
		try {
			const { installation_id: installationIdRaw, state: returnedState } = req.query;
			const pending = pendingInstall;
			pendingInstall = undefined;

			if (
				pending === undefined ||
				typeof installationIdRaw !== "string" ||
				typeof returnedState !== "string" ||
				returnedState !== pending.state ||
				Date.now() >= pending.expiresAt
			) {
				res.redirect("/?account=error&reason=the+installation+request+expired+or+was+invalid");
				return;
			}

			const installationId = Number(installationIdRaw);
			const repos = await listInstallationRepos(installationId);
			const firstOwner = repos[0]?.owner;

			const binding: InstallationBinding = {
				installationId,
				accountLogin: firstOwner ?? `installation-${installationId}`,
				accountType: "Organization",
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
			res.json({ repos, selected: binding.selectedRepo });
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
