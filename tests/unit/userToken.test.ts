import { describe, it, expect, afterEach } from "@jest/globals";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadUserToken, saveUserToken, clearUserToken, refreshUserTokenFromDisk } from "../../src/engine/github/userToken.js";
import { OAuthExchangeError } from "../../src/engine/github/oauth.js";
import type { OAuthConfig, OAuthDeps } from "../../src/engine/github/oauth.js";
import { createUserTokenCache } from "../../src/engine/github/userTokenCache.js";

const CONFIG: OAuthConfig = { clientId: "client-id", clientSecret: "client-secret" };

function makeOAuth(refreshAccessToken: OAuthDeps["refreshAccessToken"]): OAuthDeps {
	return {
		config: CONFIG,
		buildAuthorizeUrl: () => "https://github.com/login/oauth/authorize",
		exchangeCodeForToken: async () => ({ accessToken: "unused" }),
		refreshAccessToken,
		redirectUri: "http://localhost:3000/account/github/oauth/callback",
	};
}

describe("github user token persistence", () => {
	let dir: string;

	afterEach(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	it("returns undefined when no token file exists", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-user-token-"));
		const token = await loadUserToken(join(dir, "github-user-token.json"));
		expect(token).toBeUndefined();
	});

	it("round-trips a saved refresh token, creating parent dirs as needed", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-user-token-"));
		const path = join(dir, "nested", "github-user-token.json");

		await saveUserToken(path, { refreshToken: "refresh-1" });
		const loaded = await loadUserToken(path);

		expect(loaded).toEqual({ refreshToken: "refresh-1" });
	});

	it("treats a corrupted file as not connected", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-user-token-"));
		const path = join(dir, "github-user-token.json");
		await writeFile(path, "not json", "utf8");

		expect(await loadUserToken(path)).toBeUndefined();
	});

	it("clearUserToken removes the file without throwing if it never existed", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-user-token-"));
		const path = join(dir, "github-user-token.json");

		await expect(clearUserToken(path)).resolves.toBeUndefined();
	});

	describe("refreshUserTokenFromDisk", () => {
		it("returns false and touches nothing when no token is stored", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-user-token-"));
			const path = join(dir, "github-user-token.json");
			const cache = createUserTokenCache();

			const ok = await refreshUserTokenFromDisk("octocat", path, makeOAuth(async () => ({ accessToken: "unused" })), cache);

			expect(ok).toBe(false);
			expect(cache.get("octocat")).toBeUndefined();
		});

		it("mints a fresh access token and populates the cache from a stored refresh token", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-user-token-"));
			const path = join(dir, "github-user-token.json");
			await saveUserToken(path, { refreshToken: "refresh-1" });
			const cache = createUserTokenCache();
			const oauth = makeOAuth(async (_config, refreshToken) => {
				expect(refreshToken).toBe("refresh-1");
				return { accessToken: "new-access-token", refreshToken: "refresh-2", tokenExpiresAt: new Date(Date.now() + 3600_000).toISOString() };
			});

			const ok = await refreshUserTokenFromDisk("octocat", path, oauth, cache);

			expect(ok).toBe(true);
			expect(cache.get("octocat")).toBe("new-access-token");
		});

		it("re-persists a rotated refresh token so the next restart doesn't reuse a consumed one", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-user-token-"));
			const path = join(dir, "github-user-token.json");
			await saveUserToken(path, { refreshToken: "refresh-1" });
			const cache = createUserTokenCache();
			const oauth = makeOAuth(async () => ({ accessToken: "new-access-token", refreshToken: "refresh-2" }));

			await refreshUserTokenFromDisk("octocat", path, oauth, cache);

			expect(await loadUserToken(path)).toEqual({ refreshToken: "refresh-2" });
		});

		it("keeps the old refresh token on disk when GitHub doesn't rotate it", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-user-token-"));
			const path = join(dir, "github-user-token.json");
			await saveUserToken(path, { refreshToken: "refresh-1" });
			const cache = createUserTokenCache();
			const oauth = makeOAuth(async () => ({ accessToken: "new-access-token" }));

			await refreshUserTokenFromDisk("octocat", path, oauth, cache);

			expect(await loadUserToken(path)).toEqual({ refreshToken: "refresh-1" });
		});

		it("clears the stored token and returns false when GitHub explicitly rejects the refresh token", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-user-token-"));
			const path = join(dir, "github-user-token.json");
			await saveUserToken(path, { refreshToken: "revoked-refresh" });
			const cache = createUserTokenCache();
			const oauth = makeOAuth(async () => {
				throw new OAuthExchangeError("GitHub rejected the OAuth exchange (bad_refresh_token)");
			});

			const ok = await refreshUserTokenFromDisk("octocat", path, oauth, cache);

			expect(ok).toBe(false);
			expect(cache.get("octocat")).toBeUndefined();
			expect(await loadUserToken(path)).toBeUndefined();
		});

		it("leaves the stored token in place on a transient (non-OAuthExchangeError) failure", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-user-token-"));
			const path = join(dir, "github-user-token.json");
			await saveUserToken(path, { refreshToken: "refresh-1" });
			const cache = createUserTokenCache();
			const oauth = makeOAuth(async () => {
				throw new TypeError("network error");
			});

			const ok = await refreshUserTokenFromDisk("octocat", path, oauth, cache);

			expect(ok).toBe(false);
			expect(await loadUserToken(path)).toEqual({ refreshToken: "refresh-1" });
		});
	});
});
