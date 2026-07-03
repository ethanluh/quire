import { describe, it, expect, afterEach, jest } from "@jest/globals";
import express from "express";
import { request as httpRequest } from "node:http";
import type { Server } from "node:http";
import { parse } from "cookie";
import { accountRouter } from "../../src/interface/server/routes/account.js";
import { requireSession } from "../../src/interface/server/middleware/requireSession.js";
import { createAllowlist } from "../../src/interface/server/allowlist.js";
import { InvalidTokenError } from "../../src/engine/github/verifyToken.js";
import type { VerifiedTokenIdentity } from "../../src/engine/github/verifyToken.js";
import { OAuthExchangeError } from "../../src/engine/github/oauth.js";
import type { OAuthConfig, OAuthDeps } from "../../src/engine/github/oauth.js";
import { SESSION_COOKIE_NAME, verifySession } from "../../src/interface/server/session.js";
import { errorHandler } from "../../src/interface/server/middleware/errors.js";
import { createUserTokenCache } from "../../src/engine/github/userTokenCache.js";
import type { UserTokenCache } from "../../src/engine/github/userTokenCache.js";

const SECRET = "test-secret";

interface RedirectResponse {
	status: number;
	location: string | undefined;
	setCookies: ReadonlyArray<string>;
}

// The OAuth callback always redirects (never JSON) — global fetch() follows redirects by
// default, which would hide the Location/Set-Cookie headers this test needs to inspect.
async function callRedirect(server: Server, path: string, cookie?: string): Promise<RedirectResponse> {
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("no address");
	return new Promise((resolve, reject) => {
		const req = httpRequest(
			{ host: "127.0.0.1", port: address.port, path, headers: cookie !== undefined ? { cookie } : {} },
			(res) => {
				res.resume();
				res.on("end", () =>
					resolve({
						status: res.statusCode ?? 0,
						location: res.headers.location,
						setCookies: res.headers["set-cookie"] ?? [],
					}),
				);
			},
		);
		req.on("error", reject);
		req.end();
	});
}

// The callback always clears the oauth-state cookie in addition to (on success) setting a
// session cookie, so there are multiple Set-Cookie headers to pick through — find by name.
function findCookie(setCookies: ReadonlyArray<string>, name: string): string | undefined {
	return setCookies.find((c) => c.startsWith(`${name}=`));
}

interface JsonResponse {
	status: number;
	body: Record<string, unknown>;
	setCookie: string | undefined;
}

async function call(server: Server, method: string, path: string, cookie?: string): Promise<JsonResponse> {
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("no address");
	const res = await fetch(`http://127.0.0.1:${address.port}${path}`, {
		method,
		headers: cookie !== undefined ? { cookie } : {},
	});
	return { status: res.status, body: (await res.json()) as Record<string, unknown>, setCookie: res.headers.get("set-cookie") ?? undefined };
}

function makeOAuthDeps(
	exchangeCodeForToken: OAuthDeps["exchangeCodeForToken"] = async () => ({ accessToken: "oauth-access-token" }),
): OAuthDeps {
	return {
		config: { clientId: "client-id", clientSecret: "client-secret" },
		buildAuthorizeUrl: (config: OAuthConfig, redirectUri: string, state: string) =>
			`https://github.com/login/oauth/authorize?client_id=${config.clientId}&redirect_uri=${redirectUri}&state=${state}`,
		exchangeCodeForToken,
		refreshAccessToken: async () => ({ accessToken: "unused" }),
		redirectUri: "http://localhost:3000/account/github/oauth/callback",
	};
}

describe("accountRouter (login-only)", () => {
	let server: Server;

	afterEach(async () => {
		if (server) await new Promise((resolve) => server.close(resolve));
	});

	let userTokenCache: UserTokenCache;

	function setup(
		verifyIdentity: (token: string) => Promise<VerifiedTokenIdentity>,
		allowedLogins: string | undefined,
		oauthDeps: OAuthDeps = makeOAuthDeps(),
	): void {
		const allowlist = createAllowlist(allowedLogins);
		const session = requireSession(SECRET, allowlist, false);
		userTokenCache = createUserTokenCache();
		const app = express();
		app.use(express.json());
		app.use("/account/github", accountRouter(oauthDeps, verifyIdentity, allowlist, SECRET, false, session, userTokenCache));
		app.use(errorHandler);
		server = app.listen(0);
	}

	interface PendingOAuth {
		state: string;
		cookie: string;
	}

	async function startOAuth(): Promise<PendingOAuth> {
		const { body, setCookie } = await call(server, "GET", "/account/github/oauth/start");
		const authorizeUrl = body["authorizeUrl"] as string;
		const state = new URL(authorizeUrl).searchParams.get("state");
		if (state === null) throw new Error("authorizeUrl had no state param");
		if (setCookie === undefined) throw new Error("oauth/start set no state cookie");
		return { state, cookie: setCookie.split(";")[0] ?? "" };
	}

	it("mints a fresh state when no pending-state cookie is presented", async () => {
		setup(async () => ({ login: "octocat", scopes: [] }), undefined);
		await new Promise((resolve) => server.once("listening", resolve));

		const first = await startOAuth();
		const second = await startOAuth();

		expect(first.state).not.toBe(second.state);
	});

	it("reuses the pending state when the same browser calls /oauth/start twice (double-click / second tab)", async () => {
		setup(async () => ({ login: "octocat", scopes: [] }), "octocat");
		await new Promise((resolve) => server.once("listening", resolve));

		const first = await startOAuth();
		// A second tab, or a double-click, from the SAME browser — its cookie jar already
		// holds the first call's state cookie.
		const { body: secondBody } = await call(server, "GET", "/account/github/oauth/start", first.cookie);
		const secondState = new URL(secondBody["authorizeUrl"] as string).searchParams.get("state");

		expect(secondState).toBe(first.state);

		// The first tab's already-rendered authorize URL (embedding `first.state`) still
		// completes successfully — the old singleton design's double-click tolerance,
		// restored without reintroducing cross-browser clobbering.
		const { status, location } = await callRedirect(
			server,
			`/account/github/oauth/callback?code=good-code&state=${first.state}`,
			first.cookie,
		);
		expect(status).toBe(302);
		expect(location).toBe("/?account=connected");
	});

	it("does not let one browser's /oauth/start invalidate another's in-flight login", async () => {
		setup(async () => ({ login: "octocat", scopes: [] }), "octocat");
		await new Promise((resolve) => server.once("listening", resolve));

		// Two independent browsers (cookie jars) both start a login around the same time.
		const browserA = await startOAuth();
		await startOAuth();

		// Browser A's callback fires after browser B has already started (and, under the
		// old shared-singleton design, would have clobbered A's pending state).
		const { status, location } = await callRedirect(
			server,
			`/account/github/oauth/callback?code=good-code&state=${browserA.state}`,
			browserA.cookie,
		);

		expect(status).toBe(302);
		expect(location).toBe("/?account=connected");
	});

	it("signs in via a valid code+state, setting a session cookie for an allowlisted login", async () => {
		setup(async () => ({ login: "octocat", scopes: [] }), "octocat");
		await new Promise((resolve) => server.once("listening", resolve));
		const { state, cookie } = await startOAuth();

		const { status, location, setCookies } = await callRedirect(
			server,
			`/account/github/oauth/callback?code=good-code&state=${state}`,
			cookie,
		);

		expect(status).toBe(302);
		expect(location).toBe("/?account=connected");
		const sessionCookie = findCookie(setCookies, SESSION_COOKIE_NAME);
		expect(sessionCookie).toBeDefined();
		const cookieValue = parse(sessionCookie ?? "")[SESSION_COOKIE_NAME];
		expect(verifySession(cookieValue ?? "", SECRET)?.login).toBe("octocat");
	});

	it("caches the OAuth access token in-memory, keyed by login, on a successful sign-in", async () => {
		setup(async () => ({ login: "octocat", scopes: [] }), "octocat", makeOAuthDeps(async () => ({ accessToken: "oauth-access-token" })));
		await new Promise((resolve) => server.once("listening", resolve));
		const { state, cookie } = await startOAuth();

		await callRedirect(server, `/account/github/oauth/callback?code=good-code&state=${state}`, cookie);

		expect(userTokenCache.get("octocat")).toBe("oauth-access-token");
	});

	it("rejects a login not on the allowlist, without setting a session cookie", async () => {
		setup(async () => ({ login: "octocat", scopes: [] }), "someone-else");
		await new Promise((resolve) => server.once("listening", resolve));
		const { state, cookie } = await startOAuth();

		const { status, location, setCookies } = await callRedirect(
			server,
			`/account/github/oauth/callback?code=good-code&state=${state}`,
			cookie,
		);

		expect(status).toBe(302);
		expect(location).toContain("account=error");
		expect(findCookie(setCookies, SESSION_COOKIE_NAME)).toBeUndefined();
		expect(userTokenCache.get("octocat")).toBeUndefined();
	});

	it("rejects a callback whose state doesn't match the pending one", async () => {
		setup(async () => ({ login: "octocat", scopes: [] }), undefined);
		await new Promise((resolve) => server.once("listening", resolve));
		const { cookie } = await startOAuth();

		const { status, location } = await callRedirect(
			server,
			"/account/github/oauth/callback?code=x&state=wrong-state",
			cookie,
		);

		expect(status).toBe(302);
		expect(location).toContain("account=error");
	});

	it("rejects a callback with no pending state cookie at all", async () => {
		setup(async () => ({ login: "octocat", scopes: [] }), undefined);
		await new Promise((resolve) => server.once("listening", resolve));

		const { status, location } = await callRedirect(server, "/account/github/oauth/callback?code=x&state=anything");

		expect(status).toBe(302);
		expect(location).toContain("account=error");
	});

	it("surfaces an OAuthExchangeError as an error redirect", async () => {
		const exchangeCodeForToken = jest.fn(async () => {
			throw new OAuthExchangeError("bad_verification_code");
		});
		setup(async () => ({ login: "octocat", scopes: [] }), undefined, makeOAuthDeps(exchangeCodeForToken));
		await new Promise((resolve) => server.once("listening", resolve));
		const { state, cookie } = await startOAuth();

		const { status, location } = await callRedirect(
			server,
			`/account/github/oauth/callback?code=bad&state=${state}`,
			cookie,
		);

		expect(status).toBe(302);
		expect(location).toContain("account=error");
	});

	it("surfaces a post-exchange InvalidTokenError as an error redirect", async () => {
		setup(
			async () => {
				throw new InvalidTokenError("GitHub rejected this token");
			},
			undefined,
		);
		await new Promise((resolve) => server.once("listening", resolve));
		const { state, cookie } = await startOAuth();

		const { status, location } = await callRedirect(
			server,
			`/account/github/oauth/callback?code=good&state=${state}`,
			cookie,
		);

		expect(status).toBe(302);
		expect(location).toContain("account=error");
	});

	it("GET /session reports the logged-in login when a valid cookie is presented", async () => {
		setup(async () => ({ login: "octocat", scopes: [] }), "octocat");
		await new Promise((resolve) => server.once("listening", resolve));
		const { state, cookie } = await startOAuth();
		const { setCookies } = await callRedirect(
			server,
			`/account/github/oauth/callback?code=good&state=${state}`,
			cookie,
		);
		const cookieValue = parse(findCookie(setCookies, SESSION_COOKIE_NAME) ?? "")[SESSION_COOKIE_NAME];

		const { status, body } = await call(server, "GET", "/account/github/session", `${SESSION_COOKIE_NAME}=${cookieValue}`);

		expect(status).toBe(200);
		expect(body["login"]).toBe("octocat");
	});

	it("GET /session returns 401 without a session cookie", async () => {
		setup(async () => ({ login: "octocat", scopes: [] }), undefined);
		await new Promise((resolve) => server.once("listening", resolve));

		const { status } = await call(server, "GET", "/account/github/session");

		expect(status).toBe(401);
	});

	it("POST /logout clears the session cookie", async () => {
		setup(async () => ({ login: "octocat", scopes: [] }), undefined);
		await new Promise((resolve) => server.once("listening", resolve));

		const { status, setCookie } = await call(server, "POST", "/account/github/logout");

		expect(status).toBe(200);
		expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=;`);
	});

	it("POST /logout clears the cached user token for the signed-in login", async () => {
		setup(async () => ({ login: "octocat", scopes: [] }), "octocat");
		await new Promise((resolve) => server.once("listening", resolve));
		const { state, cookie } = await startOAuth();
		const { setCookies } = await callRedirect(
			server,
			`/account/github/oauth/callback?code=good&state=${state}`,
			cookie,
		);
		const sessionCookieValue = findCookie(setCookies, SESSION_COOKIE_NAME) ?? "";
		expect(userTokenCache.get("octocat")).toBeDefined();

		await call(server, "POST", "/account/github/logout", sessionCookieValue.split(";")[0]);

		expect(userTokenCache.get("octocat")).toBeUndefined();
	});
});
