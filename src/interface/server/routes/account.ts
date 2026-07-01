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
import type { OAuthConfig } from "../../../engine/github/oauth.js";
import { OAuthExchangeError } from "../../../engine/github/oauth.js";
import { rawPRPayloadToIncomingPR } from "../../../engine/github/toIncomingPR.js";
import { normalizePR } from "../../../engine/ingest/ingest.js";
import type { Bundle } from "../../../engine/types/core.js";
import { ingestIntoQueue } from "../ingestIntoQueue.js";
import type { PipelineDeps } from "../ingestIntoQueue.js";
import type { ServerState } from "../state.js";
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

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export interface OAuthDeps {
	config: OAuthConfig;
	buildAuthorizeUrl: (config: OAuthConfig, redirectUri: string, state: string) => string;
	exchangeCodeForToken: (config: OAuthConfig, code: string, redirectUri: string) => Promise<{ accessToken: string }>;
	redirectUri: string;
}

// Where the OAuth callback sends the browser once it's done — GitHub's redirect is a
// top-level navigation, so the result is reported via a query param on the app's own
// page rather than a JSON response.
function oauthResultRedirectUrl(status: "connected" | "error", reason: string | undefined): string {
	const params = new URLSearchParams({ account: status });
	if (reason !== undefined) params.set("reason", reason);
	return `/?${params.toString()}`;
}

function buildClientForFallback(fallbackToken: string | undefined): OctokitGitHubClient | StubGitHubClient {
	return fallbackToken !== undefined && fallbackToken !== ""
		? new OctokitGitHubClient(new Octokit({ auth: fallbackToken }))
		: new StubGitHubClient();
}

function buildConnectedAccount(identity: VerifiedTokenIdentity, token: string): ConnectedAccount {
	return {
		login: identity.login,
		token,
		scopes: identity.scopes,
		connectedAt: new Date().toISOString(),
	};
}

function isBundleForRepo(bundle: Bundle, owner: string, name: string): boolean {
	return bundle.members.length > 0 && bundle.members.every((m) => m.repoOwner === owner && m.repoName === name);
}

// Drops any bundle/card whose members all belong to `repo` — used when selecting a repo
// so its queue entries get replaced rather than accumulated (re-selecting the same repo,
// or switching away from a previously selected one, both leave stale entries otherwise).
function clearRepoFromQueue(state: ServerState, repo: { owner: string; name: string } | undefined): void {
	if (repo === undefined) return;
	for (const [id, bundle] of state.bundles) {
		if (isBundleForRepo(bundle, repo.owner, repo.name)) {
			state.bundles.delete(id);
			state.cards.delete(id);
		}
	}
}

// `account` is in-memory, mirroring how ServerState holds bundles/cards/shelf in memory
// with the queue's on-disk state as the durable copy — `accountPath` is that copy.
export function githubAccountRouter(
	accountPath: string,
	clientHolder: GitHubClientHolder,
	fallbackToken: string | undefined,
	verifyToken: (token: string) => Promise<VerifiedTokenIdentity>,
	listRepos: (token: string) => Promise<ReadonlyArray<RepoSummary>>,
	initialAccount: ConnectedAccount | undefined,
	state: ServerState,
	deps: PipelineDeps,
	oauth: OAuthDeps | undefined,
): Router {
	const router = Router();
	let account = initialAccount;

	interface PendingOAuthState {
		state: string;
		expiresAt: number;
	}
	let pendingOAuth: PendingOAuthState | undefined;

	router.get("/status", (_req, res) => {
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
		});
	});

	router.get("/repos", localOnly, requireAdminHeader, async (_req, res, next) => {
		try {
			if (account === undefined) {
				res.status(400).json({ error: "Connect a GitHub account first" });
				return;
			}
			const repos = await listRepos(account.token);
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
				if (account === undefined) {
					res.status(400).json({ error: "Connect a GitHub account first" });
					return;
				}
				const { owner, name } = req.body as z.infer<typeof SelectRepoSchema>;

				// Fetch and ingest before persisting the selection: if listOpenPullRequests
				// throws (network/API/token failure), the account stays pointed at whatever
				// repo was already selected — with its queue intact — instead of "selecting"
				// a repo whose PRs never actually made it onto the queue.
				const rawPRs = await clientHolder.listOpenPullRequests(owner, name);
				const prs = rawPRs.map((raw) => normalizePR(rawPRPayloadToIncomingPR(raw)));

				// Re-populates the queue for the newly selected repo: drop bundles left over
				// from whatever was previously selected, and any earlier bundles from this
				// same repo (so re-selecting it doesn't duplicate them), before adding the
				// freshly ingested ones.
				clearRepoFromQueue(state, account.selectedRepo);
				clearRepoFromQueue(state, { owner, name });
				const summary = await ingestIntoQueue(prs, state, deps);

				account = { ...account, selectedRepo: { owner, name } };
				await saveAccount(accountPath, account);

				res.json({ selected: account.selectedRepo, ...summary });
			} catch (err) {
				next(err);
			}
		},
	);

	router.post("/connect", localOnly, requireAdminHeader, validateBody(ConnectSchema), async (req, res, next) => {
		try {
			const { token } = req.body as z.infer<typeof ConnectSchema>;
			const identity = await verifyToken(token);

			account = buildConnectedAccount(identity, token);
			await saveAccount(accountPath, account);
			clientHolder.setClient(new OctokitGitHubClient(new Octokit({ auth: token })));

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
			account = undefined;
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
				const { accessToken } = await oauth.exchangeCodeForToken(oauth.config, code, oauth.redirectUri);
				const identity = await verifyToken(accessToken);

				account = buildConnectedAccount(identity, accessToken);
				await saveAccount(accountPath, account);
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
