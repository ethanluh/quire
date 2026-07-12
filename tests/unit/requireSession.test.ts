import { describe, it, expect, jest } from "@jest/globals";
import { serialize } from "cookie";
import type { Request, Response, NextFunction } from "express";
import { requireSession } from "../../src/interface/server/middleware/requireSession.js";
import { createAllowlist } from "../../src/interface/server/allowlist.js";
import { SESSION_COOKIE_NAME, createSession } from "../../src/interface/server/session.js";
import type { SessionEpochStore } from "../../src/interface/server/sessionEpoch.js";

const SECRET = "test-secret";

// No login has ever logged out / been revoked.
const NEVER_INVALIDATED: SessionEpochStore = {
	invalidatedBefore: async () => 0,
	invalidateSessions: async () => undefined,
};

// Every session for every login was invalidated at `at` (as if everyone just logged out).
function invalidatedAt(at: number): SessionEpochStore {
	return { invalidatedBefore: async () => at, invalidateSessions: async () => undefined };
}

function makeReq(cookieHeader: string | undefined): Request {
	return { headers: { cookie: cookieHeader } } as unknown as Request;
}

function makeRes(): Response {
	const res: Partial<Response> = {};
	res.locals = {};
	res.status = jest.fn().mockReturnValue(res) as unknown as Response["status"];
	res.json = jest.fn().mockReturnValue(res) as unknown as Response["json"];
	res.cookie = jest.fn().mockReturnValue(res) as unknown as Response["cookie"];
	return res as Response;
}

describe("requireSession", () => {
	it("calls next() and sets res.locals.login for a valid, allowlisted session", async () => {
		const middleware = requireSession(SECRET, createAllowlist(undefined), false, NEVER_INVALIDATED);
		const token = createSession("octocat", SECRET);
		const req = makeReq(serialize(SESSION_COOKIE_NAME, token));
		const res = makeRes();
		const next = jest.fn() as unknown as NextFunction;

		await middleware(req, res, next);

		expect(next).toHaveBeenCalled();
		expect(res.locals.login).toBe("octocat");
		expect(res.status).not.toHaveBeenCalled();
	});

	it("rejects with 401 when there is no cookie at all", async () => {
		const middleware = requireSession(SECRET, createAllowlist(undefined), false, NEVER_INVALIDATED);
		const res = makeRes();
		const next = jest.fn() as unknown as NextFunction;

		await middleware(makeReq(undefined), res, next);

		expect(next).not.toHaveBeenCalled();
		expect(res.status).toHaveBeenCalledWith(401);
	});

	it("rejects with 401 when the cookie fails signature verification", async () => {
		const middleware = requireSession(SECRET, createAllowlist(undefined), false, NEVER_INVALIDATED);
		const token = createSession("octocat", "a-different-secret");
		const req = makeReq(serialize(SESSION_COOKIE_NAME, token));
		const res = makeRes();
		const next = jest.fn() as unknown as NextFunction;

		await middleware(req, res, next);

		expect(next).not.toHaveBeenCalled();
		expect(res.status).toHaveBeenCalledWith(401);
	});

	it("rejects a login that has since been removed from the allowlist, even with a valid signature", async () => {
		const middleware = requireSession(SECRET, createAllowlist("someone-else"), false, NEVER_INVALIDATED);
		const token = createSession("octocat", SECRET);
		const req = makeReq(serialize(SESSION_COOKIE_NAME, token));
		const res = makeRes();
		const next = jest.fn() as unknown as NextFunction;

		await middleware(req, res, next);

		expect(next).not.toHaveBeenCalled();
		expect(res.status).toHaveBeenCalledWith(401);
	});

	it("rejects a token issued before the login's session epoch (Finding 5: logout revocation)", async () => {
		const token = createSession("octocat", SECRET);
		// Simulate a logout that happened after this token was issued.
		const middleware = requireSession(SECRET, createAllowlist(undefined), false, invalidatedAt(Date.now() + 1_000));
		const req = makeReq(serialize(SESSION_COOKIE_NAME, token));
		const res = makeRes();
		const next = jest.fn() as unknown as NextFunction;

		await middleware(req, res, next);

		expect(next).not.toHaveBeenCalled();
		expect(res.status).toHaveBeenCalledWith(401);
	});

	it("accepts a token issued after the login's session epoch (post-logout re-login)", async () => {
		// Epoch is in the past; a freshly-minted token (issuedAt = now) is newer, so it's valid.
		const middleware = requireSession(SECRET, createAllowlist(undefined), false, invalidatedAt(Date.now() - 10_000));
		const token = createSession("octocat", SECRET);
		const req = makeReq(serialize(SESSION_COOKIE_NAME, token));
		const res = makeRes();
		const next = jest.fn() as unknown as NextFunction;

		await middleware(req, res, next);

		expect(next).toHaveBeenCalled();
		expect(res.locals.login).toBe("octocat");
	});

	it("re-signs a fresh cookie on every successful request (sliding expiration)", async () => {
		const middleware = requireSession(SECRET, createAllowlist(undefined), false, NEVER_INVALIDATED);
		const token = createSession("octocat", SECRET);
		const req = makeReq(serialize(SESSION_COOKIE_NAME, token));
		const res = makeRes();
		const next = jest.fn() as unknown as NextFunction;

		await middleware(req, res, next);

		expect(res.cookie).toHaveBeenCalledWith(
			SESSION_COOKIE_NAME,
			expect.any(String),
			expect.objectContaining({ httpOnly: true, sameSite: "lax" }),
		);
	});
});
