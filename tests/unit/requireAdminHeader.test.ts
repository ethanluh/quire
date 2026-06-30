import { describe, it, expect, jest } from "@jest/globals";
import { requireAdminHeader } from "../../src/server/middleware/requireAdminHeader.js";
import type { Request, Response, NextFunction } from "express";

function makeReq(headerValue: string | undefined): Request {
	return { get: () => headerValue } as unknown as Request;
}

function makeRes(): Response {
	const res: Partial<Response> = {};
	res.status = jest.fn().mockReturnValue(res) as unknown as Response["status"];
	res.json = jest.fn().mockReturnValue(res) as unknown as Response["json"];
	return res as Response;
}

describe("requireAdminHeader", () => {
	it("calls next() when the header is present", () => {
		const next = jest.fn() as unknown as NextFunction;
		const res = makeRes();
		requireAdminHeader(makeReq("1"), res, next);
		expect(next).toHaveBeenCalled();
		expect(res.status).not.toHaveBeenCalled();
	});

	it("rejects with 403 when the header is missing, blocking a bare cross-origin fetch", () => {
		const next = jest.fn() as unknown as NextFunction;
		const res = makeRes();
		requireAdminHeader(makeReq(undefined), res, next);
		expect(next).not.toHaveBeenCalled();
		expect(res.status).toHaveBeenCalledWith(403);
	});
});
