import { describe, it, expect } from "@jest/globals";
import { createAllowlist } from "../../src/interface/server/allowlist.js";

describe("createAllowlist", () => {
	it("allows any login when unset (undefined)", () => {
		const allowlist = createAllowlist(undefined);
		expect(allowlist.isAllowed("anyone")).toBe(true);
	});

	it("allows any login when set to an empty string", () => {
		const allowlist = createAllowlist("");
		expect(allowlist.isAllowed("anyone")).toBe(true);
	});

	it("allows only logins present in a comma-separated list", () => {
		const allowlist = createAllowlist("alice,bob");
		expect(allowlist.isAllowed("alice")).toBe(true);
		expect(allowlist.isAllowed("bob")).toBe(true);
		expect(allowlist.isAllowed("carol")).toBe(false);
	});

	it("matches case-insensitively and tolerates surrounding whitespace", () => {
		const allowlist = createAllowlist(" Alice , BOB ");
		expect(allowlist.isAllowed("alice")).toBe(true);
		expect(allowlist.isAllowed("ALICE")).toBe(true);
		expect(allowlist.isAllowed("bob")).toBe(true);
	});
});
