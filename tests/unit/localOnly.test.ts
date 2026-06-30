import { describe, it, expect, jest } from "@jest/globals";
import { localOnly } from "../../src/server/middleware/localOnly.js";
import type { Request, Response, NextFunction } from "express";

function makeReq(remoteAddress: string | undefined): Request {
	return { socket: { remoteAddress } } as unknown as Request;
}

function makeRes(): Response {
	const res: Partial<Response> = {};
	res.status = jest.fn().mockReturnValue(res) as unknown as Response["status"];
	res.json = jest.fn().mockReturnValue(res) as unknown as Response["json"];
	return res as Response;
}

describe("localOnly", () => {
	it.each(["127.0.0.1", "::1", "::ffff:127.0.0.1"])("calls next() for local address %s", (addr) => {
		const next = jest.fn() as unknown as NextFunction;
		const res = makeRes();
		localOnly(makeReq(addr), res, next);
		expect(next).toHaveBeenCalled();
		expect(res.status).not.toHaveBeenCalled();
	});

	it("rejects a non-local remote address with 403", () => {
		const next = jest.fn() as unknown as NextFunction;
		const res = makeRes();
		localOnly(makeReq("203.0.113.5"), res, next);
		expect(next).not.toHaveBeenCalled();
		expect(res.status).toHaveBeenCalledWith(403);
	});

	it("rejects when remote address is missing", () => {
		const next = jest.fn() as unknown as NextFunction;
		const res = makeRes();
		localOnly(makeReq(undefined), res, next);
		expect(next).not.toHaveBeenCalled();
		expect(res.status).toHaveBeenCalledWith(403);
	});
});
