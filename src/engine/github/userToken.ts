import { rm } from "node:fs/promises";
import { readJsonFile, writeJsonFileAtomic } from "../jsonFile.js";
import { OAuthExchangeError } from "./oauth.js";
import type { OAuthDeps } from "./oauth.js";
import type { UserTokenCache } from "./userTokenCache.js";

// Fallback when GitHub doesn't return expires_in (classic non-expiring user tokens) — long
// enough to be useful for a session, short enough that a leaked in-memory entry doesn't
// linger indefinitely. Shared with routes/account.ts's initial OAuth exchange.
export const DEFAULT_USER_TOKEN_TTL_MS = 60 * 60 * 1000;

// The refresh token from a signed-in user's GitHub OAuth grant — persisted (unlike the
// short-lived access token in userTokenCache.ts, which stays in-memory only) so a process
// restart can silently mint a fresh access token instead of making the user click through
// "Reconnect GitHub" again. Only usable together with the GitHub App's own client secret
// (see oauth.ts), so this carries the same risk profile as installation.json, which is
// already persisted the same way.
export interface StoredUserToken {
	refreshToken: string;
}

function isStoredUserToken(value: unknown): value is StoredUserToken {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as Record<string, unknown>)["refreshToken"] === "string"
	);
}

export async function loadUserToken(path: string): Promise<StoredUserToken | undefined> {
	return readJsonFile(path, isStoredUserToken);
}

export async function saveUserToken(path: string, token: StoredUserToken): Promise<void> {
	await writeJsonFileAtomic(path, token);
}

export async function clearUserToken(path: string): Promise<void> {
	await rm(path, { force: true });
}

// Mints a fresh access token from a persisted refresh token and populates userTokenCache,
// with no browser round-trip — called both at tenant-load time (so a server restart doesn't
// require the user to click "Reconnect GitHub") and on-demand when a request finds the
// in-memory cache empty (e.g. the access token expired mid-session). Returns whether it
// succeeded; a false leaves sortingAvailable to degrade the way a missing token always has.
//
// GitHub App refresh tokens rotate on use, so a successful call always re-persists whatever
// refresh token comes back. On an explicit rejection from GitHub (invalid/expired/revoked
// grant — surfaced as OAuthExchangeError, the only case requestToken throws that for) the
// stored file is cleared so a dead refresh token doesn't get retried on every subsequent
// cache miss; any other error (a transient network blip) leaves the file in place to retry
// later.
export async function refreshUserTokenFromDisk(
	login: string,
	path: string,
	oauth: OAuthDeps,
	userTokenCache: UserTokenCache,
): Promise<boolean> {
	const stored = await loadUserToken(path);
	if (stored === undefined) return false;

	try {
		const { accessToken, refreshToken, tokenExpiresAt } = await oauth.refreshAccessToken(oauth.config, stored.refreshToken);
		const expiresAt = tokenExpiresAt !== undefined ? new Date(tokenExpiresAt).getTime() : Date.now() + DEFAULT_USER_TOKEN_TTL_MS;
		userTokenCache.set(login, { accessToken, expiresAt });
		await saveUserToken(path, { refreshToken: refreshToken ?? stored.refreshToken });
		return true;
	} catch (err) {
		if (err instanceof OAuthExchangeError) await clearUserToken(path);
		return false;
	}
}
