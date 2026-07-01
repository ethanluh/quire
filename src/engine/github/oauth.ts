export interface OAuthConfig {
	clientId: string;
	clientSecret: string;
}

export class OAuthExchangeError extends Error {}

export function buildAuthorizeUrl(config: OAuthConfig, redirectUri: string, state: string): string {
	const params = new URLSearchParams({
		client_id: config.clientId,
		redirect_uri: redirectUri,
		scope: "repo",
		state,
	});
	return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

// Hits GitHub directly (rather than going through Octokit) so the exchange can happen
// before any GitHubClient is constructed — same rationale as fetchAuthenticatedUser.
export async function exchangeCodeForToken(
	config: OAuthConfig,
	code: string,
	redirectUri: string,
): Promise<{ accessToken: string }> {
	const response = await fetch("https://github.com/login/oauth/access_token", {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			client_id: config.clientId,
			client_secret: config.clientSecret,
			code,
			redirect_uri: redirectUri,
		}),
	});

	if (!response.ok) {
		throw new OAuthExchangeError(`GitHub returned ${response.status} while exchanging the OAuth code`);
	}

	const body: unknown = await response.json();
	const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};

	if (typeof record["error"] === "string") {
		const description = typeof record["error_description"] === "string" ? `: ${record["error_description"]}` : "";
		throw new OAuthExchangeError(`GitHub rejected the OAuth exchange (${record["error"]})${description}`);
	}

	const accessToken = record["access_token"];
	if (typeof accessToken !== "string" || accessToken.length === 0) {
		throw new OAuthExchangeError("GitHub's token response had no access_token field");
	}

	return { accessToken };
}
