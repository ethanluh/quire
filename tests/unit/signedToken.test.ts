import { describe, it, expect } from "@jest/globals";
import { signToken, verifyToken } from "../../src/interface/server/signedToken.js";

interface Widget {
	id: string;
	expiresAt: number;
}

function isWidget(value: unknown): value is Widget {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return typeof record["id"] === "string" && typeof record["expiresAt"] === "number";
}

const SECRET = "test-secret";

describe("signToken / verifyToken", () => {
	it("round-trips a valid payload", () => {
		const payload: Widget = { id: "widget-1", expiresAt: Date.now() + 60_000 };
		const token = signToken(payload, SECRET);

		expect(verifyToken(token, SECRET, isWidget)).toEqual(payload);
	});

	it("rejects a token signed with a different secret", () => {
		const token = signToken({ id: "widget-1", expiresAt: Date.now() + 60_000 }, SECRET);

		expect(verifyToken(token, "wrong-secret", isWidget)).toBeUndefined();
	});

	it("rejects a payload that doesn't match the caller's shape guard, even with a valid signature", () => {
		const token = signToken({ notAWidget: true, expiresAt: Date.now() + 60_000 }, SECRET);

		expect(verifyToken(token, SECRET, isWidget)).toBeUndefined();
	});

	it("rejects an expired payload", () => {
		const token = signToken({ id: "widget-1", expiresAt: Date.now() - 1 }, SECRET);

		expect(verifyToken(token, SECRET, isWidget)).toBeUndefined();
	});

	it("rejects malformed tokens without throwing", () => {
		expect(verifyToken("not-a-real-token", SECRET, isWidget)).toBeUndefined();
		expect(verifyToken("", SECRET, isWidget)).toBeUndefined();
		expect(verifyToken("only-one-part", SECRET, isWidget)).toBeUndefined();
	});
});
