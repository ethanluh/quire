import { describe, it, expect, jest, afterEach } from "@jest/globals";
import { createInvite, signInvite, verifyInvite } from "../../src/interface/server/invite.js";
import type { InvitePayload } from "../../src/interface/server/invite.js";

const SECRET = "test-secret";

describe("signInvite / verifyInvite", () => {
	it("round-trips a valid payload", () => {
		const payload: InvitePayload = { id: "inv-1", teamId: "team-1", invitedBy: "alice", issuedAt: Date.now(), expiresAt: Date.now() + 60_000, role: "member" };
		const token = signInvite(payload, SECRET);

		expect(verifyInvite(token, SECRET)).toEqual(payload);
	});

	it("rejects a token signed with a different secret", () => {
		const token = signInvite(
			{ id: "inv-1", teamId: "team-1", invitedBy: "alice", issuedAt: Date.now(), expiresAt: Date.now() + 60_000, role: "member" },
			SECRET,
		);

		expect(verifyInvite(token, "wrong-secret")).toBeUndefined();
	});

	it("rejects a tampered payload even if the signature format still parses", () => {
		const token = signInvite(
			{ id: "inv-1", teamId: "team-1", invitedBy: "alice", issuedAt: Date.now(), expiresAt: Date.now() + 60_000, role: "member" },
			SECRET,
		);
		const [, signature] = token.split(".");
		const tamperedBody = Buffer.from(
			JSON.stringify({ id: "inv-1", teamId: "attacker-team", invitedBy: "alice", issuedAt: 0, expiresAt: Date.now() + 60_000, role: "member" }),
		).toString("base64url");

		expect(verifyInvite(`${tamperedBody}.${signature}`, SECRET)).toBeUndefined();
	});

	it("rejects malformed tokens without throwing", () => {
		expect(verifyInvite("not-a-real-token", SECRET)).toBeUndefined();
		expect(verifyInvite("", SECRET)).toBeUndefined();
		expect(verifyInvite("only-one-part", SECRET)).toBeUndefined();
	});

	it("rejects an expired payload", () => {
		const token = signInvite(
			{ id: "inv-1", teamId: "team-1", invitedBy: "alice", issuedAt: Date.now() - 1000, expiresAt: Date.now() - 1, role: "member" },
			SECRET,
		);

		expect(verifyInvite(token, SECRET)).toBeUndefined();
	});
});

describe("createInvite", () => {
	afterEach(() => {
		jest.restoreAllMocks();
	});

	it("creates an invite that verifies successfully for the given team", () => {
		const { token, id } = createInvite("team-1", "alice", "member", SECRET);
		const payload = verifyInvite(token, SECRET);

		expect(payload?.id).toBe(id);
		expect(payload?.teamId).toBe("team-1");
		expect(payload?.invitedBy).toBe("alice");
		expect(payload?.expiresAt).toBeGreaterThan(Date.now());
	});

	it("mints a fresh id on every call", () => {
		const first = createInvite("team-1", "alice", "member", SECRET);
		const second = createInvite("team-1", "alice", "member", SECRET);

		expect(first.id).not.toBe(second.id);
	});

	it("expires after the 7-day TTL, not immediately and not forever", () => {
		let now = Date.now();
		jest.spyOn(Date, "now").mockImplementation(() => now);

		const { token } = createInvite("team-1", "alice", "member", SECRET);
		expect(verifyInvite(token, SECRET)).toBeDefined();

		now += 8 * 24 * 60 * 60 * 1000;
		expect(verifyInvite(token, SECRET)).toBeUndefined();
	});
});
