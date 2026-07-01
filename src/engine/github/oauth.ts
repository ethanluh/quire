export interface OAuthConfig {
	clientId: string;
	clientSecret: string;
}

export interface OAuthTokenResult {
	accessToken: string;
	// Only present if the OAuth App (or an org policy) has token expiration turned on —
	// classic OAuth App tokens (github.com/login/oauth/authorize) don't expire otherwise,
	// and GitHub sends neither field in that case.
	refreshToken?: string;
	tokenExpiresAt?: string;
}

export class OAuthExchangeError extends Error {}

// Bundles OAuth config with its callable functions so routes/account.ts (start/callback)
// and tokenRefresh.ts (background refresh) can both take one injectable dependency object
// — tests supply fakes here instead of mocking global.fetch.
export interface OAuthDeps {
	config: OAuthConfig;
	buildAuthorizeUrl: (config: OAuthConfig, redirectUri: string, state: string) => string;
	exchangeCodeForToken: (config: OAuthConfig, code: string, redirectUri: string) => Promise<OAuthTokenResult>;
	refreshAccessToken: (config: OAuthConfig, refreshToken: string) => Promise<OAuthTokenResult>;
	redirectUri: string;
}

export function buildAuthorizeUrl(config: OAuthConfig, redirectUri: string, state: string): string {
	const params = new URLSearchParams({
		client_id: config.clientId,
		redirect_uri: redirectUri,
		// admin:repo_hook lets Quire register/remove the webhook it uses for near-real-time
		// PR ingestion. A token missing this scope still works everywhere else — webhook
		// auto-registration just reports failure and Quire falls back to periodic polling.
		scope: "repo admin:repo_hook",
		state,
	});
	return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

async function requestToken(body: Record<string, string>): Promise<OAuthTokenResult> {
	const response = await fetch("https://github.com/login/oauth/access_token", {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});

	if (!response.ok) {
		throw new OAuthExchangeError(`GitHub returned ${response.status} while exchanging the OAuth code`);
	}

	const parsed: unknown = await response.json();
	const record = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};

	if (typeof record["error"] === "string") {
		const description = typeof record["error_description"] === "string" ? `: ${record["error_description"]}` : "";
		throw new OAuthExchangeError(`GitHub rejected the OAuth exchange (${record["error"]})${description}`);
	}

	const accessToken = record["access_token"];
	if (typeof accessToken !== "string" || accessToken.length === 0) {
		throw new OAuthExchangeError("GitHub's token response had no access_token field");
	}

	const refreshToken = typeof record["refresh_token"] === "string" ? record["refresh_token"] : undefined;
	const expiresIn = typeof record["expires_in"] === "number" ? record["expires_in"] : undefined;
	const tokenExpiresAt = expiresIn !== undefined ? new Date(Date.now() + expiresIn * 1000).toISOString() : undefined;

	return {
		accessToken,
		...(refreshToken !== undefined ? { refreshToken } : {}),
		...(tokenExpiresAt !== undefined ? { tokenExpiresAt } : {}),
	};
}

// Hits GitHub directly (rather than going through Octokit) so the exchange can happen
// before any GitHubClient is constructed — same rationale as fetchAuthenticatedUser.
export async function exchangeCodeForToken(
	config: OAuthConfig,
	code: string,
	redirectUri: string,
): Promise<OAuthTokenResult> {
	return requestToken({
		client_id: config.clientId,
		client_secret: config.clientSecret,
		code,
		redirect_uri: redirectUri,
	});
}

export async function refreshAccessToken(config: OAuthConfig, refreshToken: string): Promise<OAuthTokenResult> {
	return requestToken({
		client_id: config.clientId,
		client_secret: config.clientSecret,
		grant_type: "refresh_token",
		refresh_token: refreshToken,
	});
}
