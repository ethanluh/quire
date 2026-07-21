import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";
import { throttling } from "@octokit/plugin-throttling";
import { retry } from "@octokit/plugin-retry";
import { OctokitGitHubClient, isHttpError } from "./octokitClient.js";

// The installation client is the one that fans out — ~3 calls per open PR per refresh,
// across every tenant and every repo on the reconcile timer — so it's the one that trips
// GitHub's primary/secondary rate limits. Without these plugins a 429/secondary-limit
// response just threw, the refresh died, and the next poll re-tripped the same limit.
// throttling waits out rate-limit windows (bounded retries below); retry handles transient
// 5xx. The user/app clients below (single interactive calls) stay plain Octokit.
const ThrottledOctokit = Octokit.plugin(throttling, retry);
const MAX_RATE_LIMIT_RETRIES = 2;
// GitHub's Retry-After on a rate limit can legitimately be minutes long; honoring it verbatim
// is what let a single refresh hang well past Cloudflare's own proxy timeout with no error
// surfaced anywhere. Past this ceiling, fail fast instead of sleeping through it — the caller
// (refreshRepoQueue's REFRESH_TIMEOUT_MS) has its own bounded timeout upstream regardless.
const MAX_RATE_LIMIT_RETRY_AFTER_SECONDS = 10;
// No client-side connect/response timeout exists anywhere in the default Octokit fetch, so a
// stalled GitHub request (not a rate limit, just a hung socket) could otherwise wait forever.
const REQUEST_TIMEOUT_MS = 20_000;

interface ThrottleCallbackOptions {
	method: string;
	url: string;
}

export function shouldRetryRateLimit(retryAfter: number, retryCount: number): boolean {
	return retryAfter <= MAX_RATE_LIMIT_RETRY_AFTER_SECONDS && retryCount < MAX_RATE_LIMIT_RETRIES;
}

const throttleOptions = {
	onRateLimit: (retryAfter: number, options: ThrottleCallbackOptions, _octokit: unknown, retryCount: number): boolean => {
		console.warn(`GitHub rate limit hit on ${options.method} ${options.url}; retrying after ${retryAfter}s (attempt ${retryCount + 1})`);
		return shouldRetryRateLimit(retryAfter, retryCount);
	},
	onSecondaryRateLimit: (retryAfter: number, options: ThrottleCallbackOptions, _octokit: unknown, retryCount: number): boolean => {
		console.warn(
			`GitHub secondary rate limit hit on ${options.method} ${options.url}; retrying after ${retryAfter}s (attempt ${retryCount + 1})`,
		);
		return shouldRetryRateLimit(retryAfter, retryCount);
	},
};

// Wraps the global fetch with a per-call timeout: Octokit has no built-in connect/response
// timeout, so without this a single stalled GitHub request could hang indefinitely regardless
// of anything the throttling plugin does.
function fetchWithTimeout(url: string | URL | Request, init?: RequestInit): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error(`GitHub request timed out after ${REQUEST_TIMEOUT_MS}ms`)), REQUEST_TIMEOUT_MS);
	const externalSignal = init?.signal;
	const onExternalAbort = (): void => controller.abort(externalSignal?.reason);
	externalSignal?.addEventListener("abort", onExternalAbort);
	return fetch(url, { ...init, signal: controller.signal }).finally(() => {
		clearTimeout(timer);
		externalSignal?.removeEventListener("abort", onExternalAbort);
	});
}

export interface GitHubAppConfig {
	appId: string;
	privateKey: string;
}

// Thrown when a token-mint or API call fails because the installation was removed,
// suspended, or lost access to the repo in question (401/404 from GitHub's side) —
// replaces the old ensureValidAccessToken/NeedsReconnectError flow. There's no proactive
// pre-check the way an expiring OAuth token had one: an installation grant doesn't decay
// on a schedule, it just works or it doesn't, discovered by the call itself.
export class InstallationRevokedError extends Error {}

export function isInstallationRevoked(err: unknown): boolean {
	return isHttpError(err) && (err.status === 401 || err.status === 404);
}

export function buildInstallationOctokit(config: GitHubAppConfig, installationId: number): Octokit {
	return new ThrottledOctokit({
		authStrategy: createAppAuth,
		auth: { appId: config.appId, privateKey: config.privateKey, installationId },
		throttle: throttleOptions,
		request: { fetch: fetchWithTimeout },
	});
}

// Mints a raw token scoped to a single repo, read-only — used only for mounting a repo
// read-only into a Managed Agents session (see deepConflictInvestigation.ts), which needs a
// bare token string rather than a pre-configured Octokit instance. `createAppAuth` is called
// directly here (not via Octokit's authStrategy, which never exposes the raw token) with
// narrow `repositoryNames`/`permissions` so the minted token can't reach any other repo or
// write anything, even though the parent installation's own grant may be broader.
export async function mintScopedRepoToken(config: GitHubAppConfig, installationId: number, repoName: string): Promise<string> {
	const auth = createAppAuth({ appId: config.appId, privateKey: config.privateKey });
	const { token } = await auth({
		type: "installation",
		installationId,
		repositoryNames: [repoName],
		permissions: { contents: "read" },
	});
	return token;
}

// A plain user-authenticated client (the sign-in OAuth token, cached in-memory — see
// userTokenCache.ts), used only for the handful of user-scoped calls an installation
// client can't make (starred/pinned repos). Never used for anything ingestion-related.
export function buildUserOctokit(accessToken: string): Octokit {
	return new Octokit({ auth: accessToken });
}

// OctokitGitHubClient itself needs no changes to support this — it only ever calls
// this.octokit.rest.*/graphql/paginate, agnostic to how the instance authenticates.
export function buildInstallationClient(config: GitHubAppConfig, installationId: number): OctokitGitHubClient {
	return new OctokitGitHubClient(buildInstallationOctokit(config, installationId));
}

export interface InstallationAccount {
	accountLogin: string;
	accountType: "User" | "Organization";
}

// No installationId here — GET /app/installations/{id} is an app-level endpoint,
// authenticated as the app itself (a JWT), not as any one installation.
function buildAppOctokit(config: GitHubAppConfig): Octokit {
	return new Octokit({
		authStrategy: createAppAuth,
		auth: { appId: config.appId, privateKey: config.privateKey },
	});
}

// Looked up directly rather than guessed from the installation's repo list (which is
// empty for a repo-less org install, and says nothing about account type anyway).
export async function getInstallationAccount(
	config: GitHubAppConfig,
	installationId: number,
): Promise<InstallationAccount> {
	const { data } = await buildAppOctokit(config).rest.apps.getInstallation({ installation_id: installationId });
	// `account` is a simple-user for a User/Organization install, or an `enterprise` (no
	// `login` field, only `slug`) for the rare enterprise-owned case — fall back the same
	// way the old repo-derived logic did when there's nothing else to go on.
	const account = data.account;
	const accountLogin = account !== null && account !== undefined && "login" in account ? account.login : undefined;
	return {
		accountLogin: accountLogin ?? `installation-${installationId}`,
		accountType: data.target_type === "User" ? "User" : "Organization",
	};
}

export interface AccessibleInstallation extends InstallationAccount {
	installationId: number;
}

// Lists installations of *this* App that the signed-in user can already see, using the
// same cached sign-in token as buildUserOctokit — GitHub scopes the response to the App
// tied to the token's client id, so no separate appSlug filtering is needed here. This is
// what lets Settings offer "Connect" instead of funneling an already-installed user
// through the "Install GitHub App" wizard again.
export async function listInstallationsForUser(accessToken: string): Promise<ReadonlyArray<AccessibleInstallation>> {
	const { data } = await buildUserOctokit(accessToken).rest.apps.listInstallationsForAuthenticatedUser();
	return data.installations.map((installation) => {
		const account = installation.account;
		const accountLogin = account !== null && account !== undefined && "login" in account ? account.login : undefined;
		return {
			installationId: installation.id,
			accountLogin: accountLogin ?? `installation-${installation.id}`,
			accountType: installation.target_type === "User" ? "User" : "Organization",
		};
	});
}
