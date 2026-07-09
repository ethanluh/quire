import { describe, it, expect, jest, afterEach } from "@jest/globals";
import { createSession, renewSession, signSession, verifySession } from "../../src/interface/server/session.js";

const SECRET = "test-secret";

describe("signSession / verifySession", () => {
	it("round-trips a valid payload", () => {
		const payload = { login: "octocat", issuedAt: Date.now(), expiresAt: Date.now() + 60_000 };
		const token = signSession(payload, SECRET);

		expect(verifySession(token, SECRET)).toEqual(payload);
	});

	it("rejects a token signed with a different secret", () => {
		const token = signSession({ login: "octocat", issuedAt: Date.now(), expiresAt: Date.now() + 60_000 }, SECRET);

		expect(verifySession(token, "wrong-secret")).toBeUndefined();
	});

	it("rejects a tampered payload even if the signature format still parses", () => {
		const token = signSession({ login: "octocat", issuedAt: Date.now(), expiresAt: Date.now() + 60_000 }, SECRET);
		const [body, signature] = token.split(".");
		const tamperedBody = Buffer.from(JSON.stringify({ login: "attacker", issuedAt: 0, expiresAt: Date.now() + 60_000 })).toString(
			"base64url",
		);

		expect(verifySession(`${tamperedBody}.${signature}`, SECRET)).toBeUndefined();
	});

	it("rejects malformed tokens without throwing", () => {
		expect(verifySession("not-a-real-token", SECRET)).toBeUndefined();
		expect(verifySession("", SECRET)).toBeUndefined();
		expect(verifySession("only-one-part", SECRET)).toBeUndefined();
	});

	it("rejects an expired payload", () => {
		const token = signSession({ login: "octocat", issuedAt: Date.now() - 1000, expiresAt: Date.now() - 1 }, SECRET);

		expect(verifySession(token, SECRET)).toBeUndefined();
	});
});

describe("createSession / renewSession", () => {
	afterEach(() => {
		jest.restoreAllMocks();
	});

	it("creates a session that verifies successfully for the given login", () => {
		const token = createSession("octocat", SECRET);
		const payload = verifySession(token, SECRET);

		expect(payload?.login).toBe("octocat");
		expect(payload?.expiresAt).toBeGreaterThan(Date.now());
	});

	it("renewSession issues a fresh token with a later expiry but preserves the original issuedAt", () => {
		let now = Date.now();
		jest.spyOn(Date, "now").mockImplementation(() => now);

		const first = createSession("octocat", SECRET);
		const firstPayload = verifySession(first, SECRET);
		now += 1000;
		const renewed = renewSession(firstPayload!, SECRET);

		expect(renewed).not.toBe(first);
		const renewedPayload = verifySession(renewed, SECRET);
		expect(renewedPayload?.expiresAt).toBeGreaterThan(firstPayload?.expiresAt as number);
		// Sliding expiry must NOT reset issuedAt — that's what bounds a renewed stolen cookie.
		expect(renewedPayload?.issuedAt).toBe(firstPayload?.issuedAt);
	});
});
