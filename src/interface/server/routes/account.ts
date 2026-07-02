import { Router } from "express";
import type { RequestHandler } from "express";
import type { Allowlist } from "../allowlist.js";
import type { OAuthDeps } from "../../../engine/github/oauth.js";
import { OAuthExchangeError } from "../../../engine/github/oauth.js";
import { InvalidTokenError } from "../../../engine/github/verifyToken.js";
import type { VerifiedTokenIdentity } from "../../../engine/github/verifyToken.js";
import { SESSION_COOKIE_NAME, SESSION_TTL_MS, createSession } from "../session.js";
import { cookieOptions, mintOrReuseStateCookie, consumeStateCookie } from "../stateCookie.js";

const OAUTH_STATE_COOKIE_NAME = "quire_oauth_state";
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

// Where the OAuth callback sends the browser once it's done — GitHub's redirect is a
// top-level navigation, so the result is reported via a query param on the app's own
// page rather than a JSON response.
function oauthResultRedirectUrl(status: "connected" | "error", reason: string | undefined): string {
	const params = new URLSearchParams({ account: status });
	if (reason !== undefined) params.set("reason", reason);
	return `/?${params.toString()}`;
}

// Pure identity: "Sign in with GitHub" using the GitHub App's own OAuth (protocol-
// identical to a standalone OAuth App's, just with no scope requested — the resulting
// token is used once, here, to resolve who is signing in via verifyIdentity, then
// discarded. It is never used to call the GitHub API; that access comes from a separate
// installation binding (routes/githubApp.ts), which is why this router no longer has a
// PAT-based /connect or any /repos*/disconnect routes — those belonged to the old
// token-owns-API-access model this replaces.
export function accountRouter(
	oauth: OAuthDeps,
	verifyIdentity: (token: string) => Promise<VerifiedTokenIdentity>,
	allowlist: Allowlist,
	sessionSecret: string,
	secureCookies: boolean,
	requireSession: RequestHandler,
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
			res.redirect(oauthResultRedirectUrl("error", "the sign-in request expired or was invalid"));
			return;
		}

		try {
			const { accessToken } = await oauth.exchangeCodeForToken(oauth.config, code, oauth.redirectUri);
			const identity = await verifyIdentity(accessToken);

			if (!allowlist.isAllowed(identity.login)) {
				res.redirect(
					oauthResultRedirectUrl("error", "this GitHub account is not authorized to use this Quire instance"),
				);
				return;
			}

			res.cookie(SESSION_COOKIE_NAME, createSession(identity.login, sessionSecret), cookieOptions(secureCookies, SESSION_TTL_MS));
			res.redirect(oauthResultRedirectUrl("connected", undefined));
		} catch (err) {
			const reason =
				err instanceof OAuthExchangeError || err instanceof InvalidTokenError
					? err.message
					: "sign-in failed unexpectedly";
			res.redirect(oauthResultRedirectUrl("error", reason));
		}
	});

	// Cheap "am I logged in" check for the frontend's initial render. Unlike every other
	// route in this file, this one DOES require a valid session — applied per-route
	// (rather than mounting this whole router behind requireSession) so /oauth/start,
	// /oauth/callback, and /logout stay reachable without one.
	router.get("/session", requireSession, (_req, res) => {
		res.json({ login: res.locals.login });
	});

	router.post("/logout", (_req, res) => {
		res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
		res.json({ loggedOut: true });
	});

	return router;
}
