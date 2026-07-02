import { describe, it, expect, afterEach } from "@jest/globals";
import { buildAuthorizeUrl, exchangeCodeForToken, refreshAccessToken, OAuthExchangeError } from "../../src/engine/github/oauth.js";
import type { OAuthConfig } from "../../src/engine/github/oauth.js";

const CONFIG: OAuthConfig = { clientId: "client-id", clientSecret: "client-secret" };

function mockFetch(response: Pick<Response, "ok" | "status"> & { json: () => Promise<unknown> }): void {
	global.fetch = (async () => response as Response) as unknown as typeof fetch;
}

describe("buildAuthorizeUrl", () => {
	it("includes client_id, redirect_uri, and state, with no scope requested by default", () => {
		const url = buildAuthorizeUrl(CONFIG, "http://localhost:3000/account/github/oauth/callback", "nonce-1");
		const parsed = new URL(url);

		expect(parsed.origin + parsed.pathname).toBe("https://github.com/login/oauth/authorize");
		expect(parsed.searchParams.get("client_id")).toBe("client-id");
		expect(parsed.searchParams.get("redirect_uri")).toBe("http://localhost:3000/account/github/oauth/callback");
		expect(parsed.searchParams.get("state")).toBe("nonce-1");
		expect(parsed.searchParams.has("scope")).toBe(false);
	});

	it("includes an explicitly requested scope when the caller passes one", () => {
		const url = buildAuthorizeUrl(CONFIG, "http://localhost:3000/callback", "nonce-1", "repo");
		const parsed = new URL(url);

		expect(parsed.searchParams.get("scope")).toBe("repo");
	});
});

describe("exchangeCodeForToken", () => {
	const originalFetch = global.fetch;

	afterEach(() => {
		global.fetch = originalFetch;
	});

	it("returns just the access token when GitHub doesn't include expiry fields (classic non-expiring OAuth App)", async () => {
		mockFetch({ ok: true, status: 200, json: async () => ({ access_token: "tok-1" }) });

		const result = await exchangeCodeForToken(CONFIG, "code", "http://localhost:3000/callback");

		expect(result).toEqual({ accessToken: "tok-1" });
		expect(result.refreshToken).toBeUndefined();
		expect(result.tokenExpiresAt).toBeUndefined();
	});

	it("captures refresh_token and computes tokenExpiresAt when the OAuth App has token expiration enabled", async () => {
		mockFetch({
			ok: true,
			status: 200,
			json: async () => ({ access_token: "tok-1", refresh_token: "refresh-1", expires_in: 28800 }),
		});

		const result = await exchangeCodeForToken(CONFIG, "code", "http://localhost:3000/callback");

		expect(result.accessToken).toBe("tok-1");
		expect(result.refreshToken).toBe("refresh-1");
		expect(result.tokenExpiresAt).toBeDefined();
		expect(new Date(result.tokenExpiresAt as string).getTime()).toBeGreaterThan(Date.now());
	});

	it("throws OAuthExchangeError on a non-OK response", async () => {
		mockFetch({ ok: false, status: 400, json: async () => ({}) });

		await expect(exchangeCodeForToken(CONFIG, "code", "http://localhost:3000/callback")).rejects.toBeInstanceOf(
			OAuthExchangeError,
		);
	});

	it("throws OAuthExchangeError with GitHub's error/description when present", async () => {
		mockFetch({
			ok: true,
			status: 200,
			json: async () => ({ error: "bad_verification_code", error_description: "The code has expired" }),
		});

		await expect(exchangeCodeForToken(CONFIG, "code", "http://localhost:3000/callback")).rejects.toThrow(
			/bad_verification_code.*The code has expired/,
		);
	});

	it("throws OAuthExchangeError when the response has no access_token", async () => {
		mockFetch({ ok: true, status: 200, json: async () => ({}) });

		await expect(exchangeCodeForToken(CONFIG, "code", "http://localhost:3000/callback")).rejects.toBeInstanceOf(
			OAuthExchangeError,
		);
	});
});

describe("refreshAccessToken", () => {
	const originalFetch = global.fetch;

	afterEach(() => {
		global.fetch = originalFetch;
	});

	it("sends grant_type=refresh_token with the refresh token", async () => {
		let sentBody: Record<string, unknown> = {};
		global.fetch = (async (_url: string, init?: RequestInit) => {
			sentBody = JSON.parse(init?.body as string) as Record<string, unknown>;
			return {
				ok: true,
				status: 200,
				json: async () => ({ access_token: "new-tok", refresh_token: "new-refresh", expires_in: 28800 }),
			} as Response;
		}) as unknown as typeof fetch;

		const result = await refreshAccessToken(CONFIG, "old-refresh");

		expect(sentBody["grant_type"]).toBe("refresh_token");
		expect(sentBody["refresh_token"]).toBe("old-refresh");
		expect(result.accessToken).toBe("new-tok");
		expect(result.refreshToken).toBe("new-refresh");
	});

	it("propagates a rotated refresh token, or lets the caller fall back to the old one when absent", async () => {
		mockFetch({ ok: true, status: 200, json: async () => ({ access_token: "new-tok" }) });

		const result = await refreshAccessToken(CONFIG, "old-refresh");

		expect(result.refreshToken).toBeUndefined();
	});

	it("throws OAuthExchangeError when GitHub rejects the refresh token", async () => {
		mockFetch({ ok: true, status: 200, json: async () => ({ error: "bad_refresh_token" }) });

		await expect(refreshAccessToken(CONFIG, "old-refresh")).rejects.toBeInstanceOf(OAuthExchangeError);
	});
});
