export interface CachedUserToken {
	accessToken: string;
	expiresAt: number;
}

// A signed-in user's OAuth access token, kept in process memory only — never persisted to
// disk, never placed in the session cookie. It exists solely so the repo picker can call
// starred/pinned APIs "as the user" (an installation-authenticated client has no such
// concept). Every consumer treats a missing/expired entry as "skip the enrichment,"
// mirroring how the old personal-token model degraded on scope/SSO/transient failures
// rather than erroring.
export interface UserTokenCache {
	get(login: string): string | undefined;
	set(login: string, token: CachedUserToken): void;
	clear(login: string): void;
}

export function createUserTokenCache(): UserTokenCache {
	const tokens = new Map<string, CachedUserToken>();
	return {
		get(login) {
			const cached = tokens.get(login);
			if (cached === undefined) return undefined;
			if (Date.now() >= cached.expiresAt) {
				tokens.delete(login);
				return undefined;
			}
			return cached.accessToken;
		},
		set(login, token) {
			tokens.set(login, token);
		},
		clear(login) {
			tokens.delete(login);
		},
	};
}
