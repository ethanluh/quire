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

const SECRET = "test-secret";

interface RedirectResponse {
	status: number;
	location: string | undefined;
	setCookie: string | undefined;
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
						setCookie: res.headers["set-cookie"]?.[0],
					}),
				);
			},
		);
		req.on("error", reject);
		req.end();
	});
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

	function setup(
		verifyIdentity: (token: string) => Promise<VerifiedTokenIdentity>,
		allowedLogins: string | undefined,
		oauthDeps: OAuthDeps = makeOAuthDeps(),
	): void {
		const allowlist = createAllowlist(allowedLogins);
		const session = requireSession(SECRET, allowlist, false);
		const app = express();
		app.use(express.json());
		app.use("/account/github", accountRouter(oauthDeps, verifyIdentity, allowlist, SECRET, false, session));
		app.use(errorHandler);
		server = app.listen(0);
	}

	async function startOAuth(): Promise<string> {
		const { body } = await call(server, "GET", "/account/github/oauth/start");
		const authorizeUrl = body["authorizeUrl"] as string;
		const state = new URL(authorizeUrl).searchParams.get("state");
		if (state === null) throw new Error("authorizeUrl had no state param");
		return state;
	}

	it("reuses the same pending state across repeated /oauth/start calls (idempotent against a double-click)", async () => {
		setup(async () => ({ login: "octocat", scopes: [] }), undefined);
		await new Promise((resolve) => server.once("listening", resolve));

		const first = await startOAuth();
		const second = await startOAuth();

		expect(first).toBe(second);
	});

	it("signs in via a valid code+state, setting a session cookie for an allowlisted login", async () => {
		setup(async () => ({ login: "octocat", scopes: [] }), "octocat");
		await new Promise((resolve) => server.once("listening", resolve));
		const state = await startOAuth();

		const { status, location, setCookie } = await callRedirect(
			server,
			`/account/github/oauth/callback?code=good-code&state=${state}`,
		);

		expect(status).toBe(302);
		expect(location).toBe("/?account=connected");
		expect(setCookie).toBeDefined();
		const cookieValue = parse(setCookie ?? "")[SESSION_COOKIE_NAME];
		expect(verifySession(cookieValue ?? "", SECRET)?.login).toBe("octocat");
	});

	it("rejects a login not on the allowlist, without setting a cookie", async () => {
		setup(async () => ({ login: "octocat", scopes: [] }), "someone-else");
		await new Promise((resolve) => server.once("listening", resolve));
		const state = await startOAuth();

		const { status, location, setCookie } = await callRedirect(
			server,
			`/account/github/oauth/callback?code=good-code&state=${state}`,
		);

		expect(status).toBe(302);
		expect(location).toContain("account=error");
		expect(setCookie).toBeUndefined();
	});

	it("rejects a callback whose state doesn't match the pending one", async () => {
		setup(async () => ({ login: "octocat", scopes: [] }), undefined);
		await new Promise((resolve) => server.once("listening", resolve));
		await startOAuth();

		const { status, location } = await callRedirect(server, "/account/github/oauth/callback?code=x&state=wrong-state");

		expect(status).toBe(302);
		expect(location).toContain("account=error");
	});

	it("surfaces an OAuthExchangeError as an error redirect", async () => {
		const exchangeCodeForToken = jest.fn(async () => {
			throw new OAuthExchangeError("bad_verification_code");
		});
		setup(async () => ({ login: "octocat", scopes: [] }), undefined, makeOAuthDeps(exchangeCodeForToken));
		await new Promise((resolve) => server.once("listening", resolve));
		const state = await startOAuth();

		const { status, location } = await callRedirect(server, `/account/github/oauth/callback?code=bad&state=${state}`);

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
		const state = await startOAuth();

		const { status, location } = await callRedirect(server, `/account/github/oauth/callback?code=good&state=${state}`);

		expect(status).toBe(302);
		expect(location).toContain("account=error");
	});

	it("GET /session reports the logged-in login when a valid cookie is presented", async () => {
		setup(async () => ({ login: "octocat", scopes: [] }), "octocat");
		await new Promise((resolve) => server.once("listening", resolve));
		const state = await startOAuth();
		const { setCookie } = await callRedirect(server, `/account/github/oauth/callback?code=good&state=${state}`);
		const cookieValue = parse(setCookie ?? "")[SESSION_COOKIE_NAME];

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
});
