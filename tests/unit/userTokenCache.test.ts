import { describe, it, expect } from "@jest/globals";
import { createUserTokenCache } from "../../src/engine/github/userTokenCache.js";

describe("userTokenCache", () => {
	it("returns undefined for a login with no cached token", () => {
		const cache = createUserTokenCache();

		expect(cache.get("octocat")).toBeUndefined();
	});

	it("returns the cached token while it's still fresh", () => {
		const cache = createUserTokenCache();

		cache.set("octocat", { accessToken: "token-a", expiresAt: Date.now() + 60_000 });

		expect(cache.get("octocat")).toBe("token-a");
	});

	it("treats an already-expired token as absent", () => {
		const cache = createUserTokenCache();

		cache.set("octocat", { accessToken: "token-a", expiresAt: Date.now() - 1 });

		expect(cache.get("octocat")).toBeUndefined();
	});

	it("keeps tokens for different logins independent", () => {
		const cache = createUserTokenCache();

		cache.set("octocat", { accessToken: "token-a", expiresAt: Date.now() + 60_000 });
		cache.set("hubot", { accessToken: "token-b", expiresAt: Date.now() + 60_000 });

		expect(cache.get("octocat")).toBe("token-a");
		expect(cache.get("hubot")).toBe("token-b");
	});

	it("clear() removes a login's cached token", () => {
		const cache = createUserTokenCache();
		cache.set("octocat", { accessToken: "token-a", expiresAt: Date.now() + 60_000 });

		cache.clear("octocat");

		expect(cache.get("octocat")).toBeUndefined();
	});

	it("clear() on a login with no cached token is a no-op", () => {
		const cache = createUserTokenCache();

		expect(() => cache.clear("octocat")).not.toThrow();
	});
});
