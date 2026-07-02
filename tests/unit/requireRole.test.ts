import { describe, it, expect, jest } from "@jest/globals";
import type { Request, Response, NextFunction } from "express";
import { requireRole } from "../../src/interface/server/middleware/requireRole.js";

function makeRes(membership: { teamId: string; role: "owner" | "admin" | "member" } | undefined): Response {
	const res: Partial<Response> = {};
	res.locals = membership === undefined ? {} : { membership };
	res.status = jest.fn().mockReturnValue(res) as unknown as Response["status"];
	res.json = jest.fn().mockReturnValue(res) as unknown as Response["json"];
	return res as Response;
}

describe("requireRole", () => {
	it("calls next() when the caller's role is in the allowed list", () => {
		const middleware = requireRole("owner");
		const res = makeRes({ teamId: "team-1", role: "owner" });
		const next = jest.fn() as unknown as NextFunction;

		middleware({} as Request, res, next);

		expect(next).toHaveBeenCalled();
		expect(res.status).not.toHaveBeenCalled();
	});

	it("allows any role in a multi-role list", () => {
		const middleware = requireRole("owner", "admin");
		const res = makeRes({ teamId: "team-1", role: "admin" });
		const next = jest.fn() as unknown as NextFunction;

		middleware({} as Request, res, next);

		expect(next).toHaveBeenCalled();
	});

	it("rejects with 403 when the caller's role isn't in the allowed list", () => {
		const middleware = requireRole("owner");
		const res = makeRes({ teamId: "team-1", role: "member" });
		const next = jest.fn() as unknown as NextFunction;

		middleware({} as Request, res, next);

		expect(next).not.toHaveBeenCalled();
		expect(res.status).toHaveBeenCalledWith(403);
	});

	it("rejects with 401 when there is no membership at all", () => {
		const middleware = requireRole("owner");
		const res = makeRes(undefined);
		const next = jest.fn() as unknown as NextFunction;

		middleware({} as Request, res, next);

		expect(next).not.toHaveBeenCalled();
		expect(res.status).toHaveBeenCalledWith(401);
	});
});
