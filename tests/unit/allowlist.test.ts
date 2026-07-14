import { describe, it, expect } from "@jest/globals";
import { createAllowlist, createPlatformAdminAllowlist } from "../../src/interface/server/allowlist.js";

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

	it("allows any login when explicitly set to the wildcard `*`", () => {
		const allowlist = createAllowlist("*");
		expect(allowlist.isAllowed("anyone")).toBe(true);
		expect(allowlist.isAllowed("someone-else")).toBe(true);
	});

	it("tolerates surrounding whitespace around the wildcard", () => {
		const allowlist = createAllowlist(" * ");
		expect(allowlist.isAllowed("anyone")).toBe(true);
	});

	// Finding 2: the production boot guard (index.ts) keys off allowsAll/explicitWildcard, not
	// raw string-emptiness. A value that is non-empty as a string but parses to nothing must
	// report allowsAll:true so the guard fails closed instead of silently admitting everyone.
	describe("allow-all classification (drives the production fail-closed guard)", () => {
		it.each([
			["undefined", undefined],
			["empty string", ""],
			["a lone comma", ","],
			["only whitespace", "   "],
			["only separators", ", ,"],
		])("reports allowsAll:true and explicitWildcard:false for %s", (_label, raw) => {
			const allowlist = createAllowlist(raw);
			expect(allowlist.allowsAll).toBe(true);
			expect(allowlist.explicitWildcard).toBe(false);
			// And it does behave as allow-all, so the guard isn't over-eager.
			expect(allowlist.isAllowed("anyone")).toBe(true);
		});

		it("reports allowsAll:true and explicitWildcard:true for the explicit wildcard", () => {
			const allowlist = createAllowlist(" * ");
			expect(allowlist.allowsAll).toBe(true);
			expect(allowlist.explicitWildcard).toBe(true);
		});

		it("reports allowsAll:false for a real login list", () => {
			const allowlist = createAllowlist("alice,bob");
			expect(allowlist.allowsAll).toBe(false);
			expect(allowlist.explicitWildcard).toBe(false);
		});
	});
});

// The platform-admin gate is the highest-privilege surface in the app (cross-tenant), so
// it must fail CLOSED when unconfigured — the opposite default of the base allowlist above.
describe("createPlatformAdminAllowlist", () => {
	it.each([
		["undefined", undefined],
		["empty string", ""],
		["only separators", ", ,"],
	])("denies everyone when unset (%s), unlike the base allowlist", (_label, raw) => {
		const allowlist = createPlatformAdminAllowlist(raw);
		expect(allowlist.isAllowed("anyone")).toBe(false);
		expect(allowlist.allowsAll).toBe(false);
	});

	it("allows only logins present in a comma-separated list", () => {
		const allowlist = createPlatformAdminAllowlist("alice");
		expect(allowlist.isAllowed("alice")).toBe(true);
		expect(allowlist.isAllowed("bob")).toBe(false);
	});

	it("honors the explicit wildcard as an intentional allow-all", () => {
		const allowlist = createPlatformAdminAllowlist("*");
		expect(allowlist.isAllowed("anyone")).toBe(true);
		expect(allowlist.explicitWildcard).toBe(true);
	});
});
