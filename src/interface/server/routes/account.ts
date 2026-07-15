import { parse } from "cookie";
import { Router } from "express";
import type { RequestHandler } from "express";
import type { Allowlist } from "../allowlist.js";
import type { OAuthDeps } from "../../../engine/github/oauth.js";
import { OAuthExchangeError } from "../../../engine/github/oauth.js";
import { InvalidTokenError } from "../../../engine/github/verifyToken.js";
import type { VerifiedTokenIdentity } from "../../../engine/github/verifyToken.js";
import type { UserTokenCache } from "../../../engine/github/userTokenCache.js";
import { saveUserToken, clearUserToken, userTokenPath, DEFAULT_USER_TOKEN_TTL_MS } from "../../../engine/github/userToken.js";
import { SESSION_COOKIE_NAME, SESSION_TTL_MS, createSession, verifySession } from "../session.js";
import { cookieOptions, mintOrReuseStateCookie, consumeStateCookie } from "../stateCookie.js";
import type { SessionEpochStore } from "../sessionEpoch.js";

const OAUTH_STATE_COOKIE_NAME = "quire_oauth_state";
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

// Where a GitHub round-trip (OAuth sign-in here, or App install in routes/githubApp.ts)
// sends the browser once it's done — the redirect is a top-level navigation, so the result
// is reported via a query param on the app's own page rather than a JSON response. Exported
// so githubApp.ts's install-callback redirects share one encoder instead of hand-concatenating
// their own query strings: URLSearchParams.toString() serializes as application/x-www-form-urlencoded,
// which encodes spaces as `+` (not %20) — byte-identical to the strings githubApp.ts used to
// inline, and read back the same way by index.html/mobile.html via new URLSearchParams(location.search).
export function accountResultRedirectUrl(status: "connected" | "error", reason: string | undefined): string {
	const params = new URLSearchParams({ account: status });
	if (reason !== undefined) params.set("reason", reason);
	return `/?${params.toString()}`;
}

// Identity first, API access second: "Sign in with GitHub" using the GitHub App's own
// OAuth (protocol-identical to a standalone OAuth App's, just with no scope requested —
// GitHub Apps take their user-to-server permissions from the App's own configuration, not
// a scope param). The resulting access token is used here to resolve who is signing in via
// verifyIdentity, then cached in-memory only (userTokenCache — never persisted to disk or
// placed in the session cookie) purely so the repo picker can enrich with the user's
// starred/pinned repos later; it is never used for anything ingestion-related. That access
// comes from a separate installation binding (routes/githubApp.ts), which is why this
// router still has no PAT-based /connect or any /repos*/disconnect routes — those belonged
// to the old token-owns-API-access model this replaces.
//
// The refresh token GitHub returns alongside it is a different story: it IS persisted (see
// userToken.ts), specifically so a server restart can silently mint a fresh access token
// instead of forcing the user through this whole OAuth round-trip again on every redeploy.
export function accountRouter(
	oauth: OAuthDeps,
	verifyIdentity: (token: string) => Promise<VerifiedTokenIdentity>,
	allowlist: Allowlist,
	sessionSecret: string,
	secureCookies: boolean,
	requireSession: RequestHandler,
	userTokenCache: UserTokenCache,
	dataDir: string,
	sessionEpochs: SessionEpochStore,
): Router {
	const router = Router();

	// GET, not POST: unlike the old dual-purpose flow, this has no side effect worth CSRF
	// protection — it only mints a nonce and returns GitHub's own authorize URL. GitHub's
	// login screen is the real gate; a page tricking a visitor into "starting" a login (via
	// GET or POST) at worst just opens a GitHub authorize prompt that bounces back to
	// Quire's own sign-in page.
	//
	// The nonce lives in a short-lived cookie scoped to the browser that started this flow,
	// not a server-wide variable — this endpoint is reachable by anyone (that's the point,
	// it's how you log in), so a shared singleton here would let any visitor silently
	// invalidate every other in-flight login on the server just by hitting this route.
	// mintOrReuseStateCookie reuses an already-pending nonce from this same browser instead
	// of always minting fresh, so a double-click or a second tab doesn't orphan the first.
	router.get("/oauth/start", (req, res) => {
		const state = mintOrReuseStateCookie(req, res, OAUTH_STATE_COOKIE_NAME, OAUTH_STATE_TTL_MS, secureCookies);
		res.json({ authorizeUrl: oauth.buildAuthorizeUrl(oauth.config, oauth.redirectUri, state) });
	});

	router.get("/oauth/callback", async (req, res) => {
		const { code, state: returnedState } = req.query;
		const pendingState = consumeStateCookie(req, res, OAUTH_STATE_COOKIE_NAME);

		if (
			pendingState === undefined ||
			typeof code !== "string" ||
			typeof returnedState !== "string" ||
			returnedState !== pendingState
		) {
			res.redirect(accountResultRedirectUrl("error", "the sign-in request expired or was invalid"));
			return;
		}

		try {
			const { accessToken, refreshToken, tokenExpiresAt } = await oauth.exchangeCodeForToken(
				oauth.config,
				code,
				oauth.redirectUri,
			);
			const identity = await verifyIdentity(accessToken);

			if (!allowlist.isAllowed(identity.login)) {
				res.redirect(
					accountResultRedirectUrl("error", "this GitHub account is not authorized to use this Quire instance"),
				);
				return;
			}

			const expiresAt = tokenExpiresAt !== undefined ? new Date(tokenExpiresAt).getTime() : Date.now() + DEFAULT_USER_TOKEN_TTL_MS;
			userTokenCache.set(identity.login, { accessToken, expiresAt });
			if (refreshToken !== undefined) {
				await saveUserToken(userTokenPath(dataDir, identity.login), { refreshToken });
			}

			res.cookie(SESSION_COOKIE_NAME, createSession(identity.login, sessionSecret), cookieOptions(secureCookies, SESSION_TTL_MS));
			res.redirect(accountResultRedirectUrl("connected", undefined));
		} catch (err) {
			const reason =
				err instanceof OAuthExchangeError || err instanceof InvalidTokenError
					? err.message
					: "sign-in failed unexpectedly";
			res.redirect(accountResultRedirectUrl("error", reason));
		}
	});

	// Cheap "am I logged in" check for the frontend's initial render. Unlike every other
	// route in this file, this one DOES require a valid session — applied per-route
	// (rather than mounting this whole router behind requireSession) so /oauth/start,
	// /oauth/callback, and /logout stay reachable without one.
	router.get("/session", requireSession, (_req, res) => {
		res.json({ login: res.locals.login });
	});

	router.post("/logout", async (req, res, next) => {
		try {
			const token = parse(req.headers.cookie ?? "")[SESSION_COOKIE_NAME];
			const payload = token !== undefined ? verifySession(token, sessionSecret) : undefined;
			if (payload !== undefined) {
				userTokenCache.clear(payload.login);
				await clearUserToken(userTokenPath(dataDir, payload.login));
				// Invalidate the just-cleared cookie server-side too: clearCookie only asks the
				// browser to drop it, but the signed token stays valid until expiry, so a copy
				// captured before logout would keep working. Bumping the login's session epoch makes
				// requireSession reject every token issued before now (see sessionEpoch.ts).
				await sessionEpochs.invalidateSessions(payload.login, Date.now());
			}

			res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
			res.json({ loggedOut: true });
		} catch (err) {
			next(err);
		}
	});

	return router;
}
