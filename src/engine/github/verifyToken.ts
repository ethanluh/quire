export interface VerifiedTokenIdentity {
	login: string;
	scopes: ReadonlyArray<string>;
}

export class InvalidTokenError extends Error {}

// Hits GitHub directly (rather than going through Octokit) so a connect attempt can be
// verified before any GitHubClient is constructed from the token.
export async function fetchAuthenticatedUser(token: string): Promise<VerifiedTokenIdentity> {
	const response = await fetch("https://api.github.com/user", {
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
		},
	});

	if (response.status === 401) {
		throw new InvalidTokenError("GitHub rejected this token");
	}
	if (!response.ok) {
		throw new Error(`GitHub returned ${response.status} while verifying the token`);
	}

	const body: unknown = await response.json();
	const login = typeof body === "object" && body !== null ? (body as Record<string, unknown>)["login"] : undefined;
	if (typeof login !== "string") {
		throw new Error("GitHub's user response had no login field");
	}

	// Fine-grained PATs don't return this header; a classic PAT does, comma-separated.
	const scopesHeader = response.headers.get("x-oauth-scopes") ?? "";
	const scopes = scopesHeader
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);

	return { login, scopes };
}
