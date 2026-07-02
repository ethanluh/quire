import { randomBytes } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { Octokit } from "@octokit/rest";
import type { ConnectedAccount } from "../../../engine/github/account.js";
import { saveAccount, clearAccount } from "../../../engine/github/account.js";
import type { GitHubClientHolder } from "../../../engine/github/clientHolder.js";
import { OctokitGitHubClient } from "../../../engine/github/octokitClient.js";
import { StubGitHubClient } from "../../../engine/github/stubClient.js";
import { InvalidTokenError } from "../../../engine/github/verifyToken.js";
import type { VerifiedTokenIdentity } from "../../../engine/github/verifyToken.js";
import type { RepoSummary } from "../../../engine/github/repos.js";
import { OAuthExchangeError } from "../../../engine/github/oauth.js";
import { NeedsReconnectError } from "../../../engine/github/tokenRefresh.js";
import { clearRepoFromQueue, enqueueRefresh, AccountChangedError } from "../refreshRepoQueue.js";
import type { RefreshDeps } from "../refreshRepoQueue.js";
import { localOnly } from "../middleware/localOnly.js";
import { requireAdminHeader } from "../middleware/requireAdminHeader.js";
import { validateBody } from "../middleware/validation.js";

const ConnectSchema = z.object({
	token: z.string().min(1),
});

const SelectRepoSchema = z.object({
	owner: z.string().min(1),
	name: z.string().min(1),
});

const SettingsSchema = z.object({
	autoMergeOnAccept: z.boolean(),
});

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const REPO_LIST_CACHE_TTL_MS = 30 * 1000;

export interface WebhookConfig {
	publicUrl: string;
	secret: string;
}

// Where the OAuth callback sends the browser once it's done — GitHub's redirect is a
// top-level navigation, so the result is reported via a query param on the app's own
// page rather than a JSON response.
function oauthResultRedirectUrl(status: "connected" | "error", reason: string | undefined): string {
	const params = new URLSearchParams({ account: status });
	if (reason !== undefined) params.set("reason", reason);
	return `/?${params.toString()}`;
}

async function deleteWebhookBestEffort(
	clientHolder: GitHubClientHolder,
	repo: { owner: string; name: string; webhookId: number },
): Promise<void> {
	await clientHolder.deleteWebhook(repo.owner, repo.name, repo.webhookId).catch((err: unknown) => {
		console.error(`Failed to delete webhook for ${repo.owner}/${repo.name}:`, err);
	});
}

function buildClientForFallback(fallbackToken: string | undefined): OctokitGitHubClient | StubGitHubClient {
	return fallbackToken !== undefined && fallbackToken !== ""
		? new OctokitGitHubClient(new Octokit({ auth: fallbackToken }))
		: new StubGitHubClient();
}

function buildConnectedAccount(
	identity: VerifiedTokenIdentity,
	token: string,
	extra: { refreshToken?: string; tokenExpiresAt?: string } = {},
): ConnectedAccount {
	return {
		login: identity.login,
		token,
		scopes: identity.scopes,
		connectedAt: new Date().toISOString(),
		...extra,
	};
}

// `refreshDeps` bundles the account's live state, its on-disk copy, the swappable GitHub
// client, OAuth config, the decided-PR store, and the pipeline — the same dependency set
// POST /repos/select needs to fetch-and-ingest, and the same one the webhook route and
// reconciliation poll need to trigger that exact same refresh from outside this router.
export function githubAccountRouter(
	refreshDeps: RefreshDeps,
	fallbackToken: string | undefined,
	verifyToken: (token: string) => Promise<VerifiedTokenIdentity>,
	listRepos: (token: string) => Promise<ReadonlyArray<RepoSummary>>,
	webhookConfig: WebhookConfig | undefined,
): Router {
	const router = Router();
	const { accountState, accountPath, clientHolder, oauth } = refreshDeps;

	interface PendingOAuthState {
		state: string;
		expiresAt: number;
	}
	let pendingOAuth: PendingOAuthState | undefined;

	interface RepoListCacheEntry {
		token: string;
		expiresAt: number;
		repos: ReadonlyArray<RepoSummary>;
	}
	let repoListCache: RepoListCacheEntry | undefined;

	router.get("/status", (_req, res) => {
		const account = accountState.current;
		if (account === undefined) {
			res.json({ connected: false, oauthAvailable: oauth !== undefined });
			return;
		}
		res.json({
			connected: true,
			login: account.login,
			scopes: account.scopes,
			connectedAt: account.connectedAt,
			selectedRepo: account.selectedRepo,
			oauthAvailable: oauth !== undefined,
			needsReconnect: account.needsReconnect ?? false,
			autoMergeOnAccept: account.autoMergeOnAccept ?? false,
		});
	});

	router.post("/settings", localOnly, requireAdminHeader, validateBody(SettingsSchema), async (req, res, next) => {
		try {
			const current = accountState.current;
			if (current === undefined) {
				res.status(400).json({ error: "Connect a GitHub account first" });
				return;
			}
			const { autoMergeOnAccept } = req.body as z.infer<typeof SettingsSchema>;
			const updated: ConnectedAccount = { ...current, autoMergeOnAccept };
			accountState.current = updated;
			await saveAccount(accountPath, updated);
			res.json({ autoMergeOnAccept });
		} catch (err) {
			next(err);
		}
	});

	router.get("/repos", localOnly, requireAdminHeader, async (_req, res, next) => {
		try {
			const account = accountState.current;
			if (account === undefined) {
				res.status(400).json({ error: "Connect a GitHub account first" });
				return;
			}
			const cached = repoListCache;
			const repos =
				cached !== undefined && cached.token === account.token && Date.now() < cached.expiresAt
					? cached.repos
					: await listRepos(account.token);
			if (cached === undefined || repos !== cached.repos) {
				repoListCache = { token: account.token, expiresAt: Date.now() + REPO_LIST_CACHE_TTL_MS, repos };
			}
			res.json({ repos, selected: account.selectedRepo });
		} catch (err) {
			next(err);
		}
	});

	router.post(
		"/repos/select",
		localOnly,
		requireAdminHeader,
		validateBody(SelectRepoSchema),
		async (req, res, next) => {
			try {
				const account = accountState.current;
				if (account === undefined) {
					res.status(400).json({ error: "Connect a GitHub account first" });
					return;
				}
				const { owner, name } = req.body as z.infer<typeof SelectRepoSchema>;
				const previousRepo = account.selectedRepo;

				// Drop the previously selected repo's bundles; refreshRepoQueue itself
				// handles clearing (and re-populating) the newly selected repo's own entries.
				clearRepoFromQueue(refreshDeps.state, previousRepo);
				const summary = await enqueueRefresh(owner, name, refreshDeps);

				if (previousRepo?.webhookId !== undefined) {
					await deleteWebhookBestEffort(clientHolder, {
						owner: previousRepo.owner,
						name: previousRepo.name,
						webhookId: previousRepo.webhookId,
					});
				}

				let webhookRegistered = false;
				let webhookError: string | undefined;
				let webhookId: number | undefined;
				if (webhookConfig !== undefined) {
					try {
						const hook = await clientHolder.createWebhook(owner, name, {
							url: `${webhookConfig.publicUrl}/webhooks/github`,
							secret: webhookConfig.secret,
						});
						webhookId = hook.id;
						webhookRegistered = true;
					} catch (err) {
						webhookError = err instanceof Error ? err.message : String(err);
					}
				}

				const current = accountState.current;
				if (current === undefined) {
					if (webhookId !== undefined) {
						await deleteWebhookBestEffort(clientHolder, { owner, name, webhookId });
					}
					throw new Error("Account was disconnected mid-request");
				}
				const updated: ConnectedAccount = {
					...current,
					selectedRepo: { owner, name, ...(webhookId !== undefined ? { webhookId } : {}) },
				};
				accountState.current = updated;
				await saveAccount(accountPath, updated);

				res.json({
					selected: updated.selectedRepo,
					...summary,
					webhookRegistered,
					...(webhookError !== undefined ? { webhookError } : {}),
					...(webhookConfig === undefined ? { webhookDisabledReason: "QUIRE_PUBLIC_URL/GITHUB_WEBHOOK_SECRET not configured" } : {}),
				});
			} catch (err) {
				next(err);
			}
		},
	);

	// A cheap, no-bookkeeping refresh of whatever repo is already selected — reused by the
	// frontend on every page load/reload so the review queue reflects GitHub's current state
	// rather than whatever happened to be in memory since the last webhook or reconcile tick.
	// Unlike /repos/select, this never touches webhooks or persisted account state.
	router.post("/repos/refresh", localOnly, requireAdminHeader, async (_req, res, next) => {
		try {
			const account = accountState.current;
			const repo = account?.selectedRepo;
			if (account === undefined || repo === undefined) {
				res.json({ refreshed: false });
				return;
			}
			const summary = await enqueueRefresh(repo.owner, repo.name, refreshDeps);
			res.json({ refreshed: true, repo, ...summary });
		} catch (err) {
			if (err instanceof NeedsReconnectError) {
				res.json({ refreshed: false, needsReconnect: true });
				return;
			}
			if (err instanceof AccountChangedError) {
				res.json({ refreshed: false });
				return;
			}
			next(err);
		}
	});

	router.post("/connect", localOnly, requireAdminHeader, validateBody(ConnectSchema), async (req, res, next) => {
		try {
			const { token } = req.body as z.infer<typeof ConnectSchema>;
			const identity = await verifyToken(token);

			accountState.current = buildConnectedAccount(identity, token);
			await saveAccount(accountPath, accountState.current);
			clientHolder.setClient(new OctokitGitHubClient(new Octokit({ auth: token })));

			const account = accountState.current;
			res.json({ connected: true, login: account.login, scopes: account.scopes, connectedAt: account.connectedAt });
		} catch (err) {
			if (err instanceof InvalidTokenError) {
				res.status(400).json({ error: err.message });
				return;
			}
			next(err);
		}
	});

	router.post("/disconnect", localOnly, requireAdminHeader, async (_req, res, next) => {
		try {
			const previousRepo = accountState.current?.selectedRepo;
			if (previousRepo?.webhookId !== undefined) {
				await deleteWebhookBestEffort(clientHolder, {
					owner: previousRepo.owner,
					name: previousRepo.name,
					webhookId: previousRepo.webhookId,
				});
			}
			accountState.current = undefined;
			await clearAccount(accountPath);
			clientHolder.setClient(buildClientForFallback(fallbackToken));
			res.json({ connected: false });
		} catch (err) {
			next(err);
		}
	});

	if (oauth !== undefined) {
		router.post("/oauth/start", localOnly, requireAdminHeader, (_req, res) => {
			// Idempotent while a flow is still pending: a double-click before the page
			// navigates away, or a second tab, reuses the same nonce instead of minting a
			// fresh one that would silently orphan the first flow's eventual callback.
			if (pendingOAuth === undefined || Date.now() >= pendingOAuth.expiresAt) {
				pendingOAuth = { state: randomBytes(32).toString("hex"), expiresAt: Date.now() + OAUTH_STATE_TTL_MS };
			}
			res.json({ authorizeUrl: oauth.buildAuthorizeUrl(oauth.config, oauth.redirectUri, pendingOAuth.state) });
		});

		router.get("/oauth/callback", localOnly, async (req, res) => {
			const { code, state: returnedState } = req.query;
			const pending = pendingOAuth;
			// Consumed before the exchange awaits, so a concurrent double-submit of the same
			// code+state can't both pass this check — only the first request still sees it.
			pendingOAuth = undefined;

			if (
				pending === undefined ||
				typeof code !== "string" ||
				typeof returnedState !== "string" ||
				returnedState !== pending.state ||
				Date.now() >= pending.expiresAt
			) {
				res.redirect(oauthResultRedirectUrl("error", "the connection request expired or was invalid"));
				return;
			}

			try {
				const { accessToken, refreshToken, tokenExpiresAt } = await oauth.exchangeCodeForToken(
					oauth.config,
					code,
					oauth.redirectUri,
				);
				const identity = await verifyToken(accessToken);

				accountState.current = buildConnectedAccount(identity, accessToken, {
					...(refreshToken !== undefined ? { refreshToken } : {}),
					...(tokenExpiresAt !== undefined ? { tokenExpiresAt } : {}),
				});
				await saveAccount(accountPath, accountState.current);
				clientHolder.setClient(new OctokitGitHubClient(new Octokit({ auth: accessToken })));

				res.redirect(oauthResultRedirectUrl("connected", undefined));
			} catch (err) {
				const reason =
					err instanceof OAuthExchangeError || err instanceof InvalidTokenError
						? err.message
						: "GitHub connection failed unexpectedly";
				res.redirect(oauthResultRedirectUrl("error", reason));
			}
		});
	}

	return router;
}
