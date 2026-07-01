import { Octokit } from "@octokit/rest";
import type { ConnectedAccount } from "./account.js";
import { saveAccount } from "./account.js";
import type { GitHubClientHolder } from "./clientHolder.js";
import { OctokitGitHubClient } from "./octokitClient.js";
import type { OAuthDeps } from "./oauth.js";

const REFRESH_BUFFER_MS = 5 * 60 * 1000;

export class NeedsReconnectError extends Error {}

export interface TokenRefreshContext {
	accountPath: string;
	clientHolder: GitHubClientHolder;
	oauth: OAuthDeps | undefined;
}

// Proactively refreshes an about-to-expire OAuth access token before a background
// (webhook- or poll-triggered) GitHub API call would otherwise start failing with 401s.
// A no-op for PATs and non-expiring OAuth tokens — tokenExpiresAt is only ever set when
// GitHub actually issued an expiring token (see oauth.ts's exchangeCodeForToken).
export async function ensureValidAccessToken(
	account: ConnectedAccount,
	ctx: TokenRefreshContext,
): Promise<ConnectedAccount> {
	if (account.tokenExpiresAt === undefined) return account;
	if (new Date(account.tokenExpiresAt).getTime() - Date.now() > REFRESH_BUFFER_MS) return account;

	if (account.refreshToken === undefined || ctx.oauth === undefined) {
		await saveAccount(ctx.accountPath, { ...account, needsReconnect: true });
		throw new NeedsReconnectError("Access token has expired and cannot be refreshed automatically");
	}

	try {
		const result = await ctx.oauth.refreshAccessToken(ctx.oauth.config, account.refreshToken);
		const refreshed: ConnectedAccount = {
			...account,
			token: result.accessToken,
			refreshToken: result.refreshToken ?? account.refreshToken,
			needsReconnect: false,
			...(result.tokenExpiresAt !== undefined ? { tokenExpiresAt: result.tokenExpiresAt } : {}),
		};
		await saveAccount(ctx.accountPath, refreshed);
		ctx.clientHolder.setClient(new OctokitGitHubClient(new Octokit({ auth: refreshed.token })));
		return refreshed;
	} catch (err) {
		await saveAccount(ctx.accountPath, { ...account, needsReconnect: true });
		throw new NeedsReconnectError(`Token refresh failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}
