import { describe, it, expect, jest } from "@jest/globals";
import { serialize } from "cookie";
import type { Request, Response, NextFunction } from "express";
import { requireSession } from "../../src/interface/server/middleware/requireSession.js";
import { createAllowlist } from "../../src/interface/server/allowlist.js";
import { SESSION_COOKIE_NAME, createSession } from "../../src/interface/server/session.js";

const SECRET = "test-secret";

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
	it("calls next() and sets res.locals.login for a valid, allowlisted session", () => {
		const middleware = requireSession(SECRET, createAllowlist(undefined), false);
		const token = createSession("octocat", SECRET);
		const req = makeReq(serialize(SESSION_COOKIE_NAME, token));
		const res = makeRes();
		const next = jest.fn() as unknown as NextFunction;

		middleware(req, res, next);

		expect(next).toHaveBeenCalled();
		expect(res.locals.login).toBe("octocat");
		expect(res.status).not.toHaveBeenCalled();
	});

	it("rejects with 401 when there is no cookie at all", () => {
		const middleware = requireSession(SECRET, createAllowlist(undefined), false);
		const res = makeRes();
		const next = jest.fn() as unknown as NextFunction;

		middleware(makeReq(undefined), res, next);

		expect(next).not.toHaveBeenCalled();
		expect(res.status).toHaveBeenCalledWith(401);
	});

	it("rejects with 401 when the cookie fails signature verification", () => {
		const middleware = requireSession(SECRET, createAllowlist(undefined), false);
		const token = createSession("octocat", "a-different-secret");
		const req = makeReq(serialize(SESSION_COOKIE_NAME, token));
		const res = makeRes();
		const next = jest.fn() as unknown as NextFunction;

		middleware(req, res, next);

		expect(next).not.toHaveBeenCalled();
		expect(res.status).toHaveBeenCalledWith(401);
	});

	it("rejects a login that has since been removed from the allowlist, even with a valid signature", () => {
		const middleware = requireSession(SECRET, createAllowlist("someone-else"), false);
		const token = createSession("octocat", SECRET);
		const req = makeReq(serialize(SESSION_COOKIE_NAME, token));
		const res = makeRes();
		const next = jest.fn() as unknown as NextFunction;

		middleware(req, res, next);

		expect(next).not.toHaveBeenCalled();
		expect(res.status).toHaveBeenCalledWith(401);
	});

	it("re-signs a fresh cookie on every successful request (sliding expiration)", () => {
		const middleware = requireSession(SECRET, createAllowlist(undefined), false);
		const token = createSession("octocat", SECRET);
		const req = makeReq(serialize(SESSION_COOKIE_NAME, token));
		const res = makeRes();
		const next = jest.fn() as unknown as NextFunction;

		middleware(req, res, next);

		expect(res.cookie).toHaveBeenCalledWith(
			SESSION_COOKIE_NAME,
			expect.any(String),
			expect.objectContaining({ httpOnly: true, sameSite: "lax" }),
		);
	});
});
