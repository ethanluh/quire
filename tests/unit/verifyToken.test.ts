import { describe, it, expect, afterEach } from "@jest/globals";
import { fetchAuthenticatedUser, InvalidTokenError } from "../../src/engine/github/verifyToken.js";

describe("fetchAuthenticatedUser", () => {
	const originalFetch = global.fetch;

	afterEach(() => {
		global.fetch = originalFetch;
	});

	function mockFetch(response: Pick<Response, "ok" | "status" | "headers"> & { json: () => Promise<unknown> }): void {
		global.fetch = (async () => response as Response) as unknown as typeof fetch;
	}

	it("returns the login and parsed scopes on success", async () => {
		mockFetch({
			ok: true,
			status: 200,
			headers: new Headers({ "x-oauth-scopes": "repo, read:org" }),
			json: async () => ({ login: "octocat" }),
		});

		const identity = await fetchAuthenticatedUser("ghp_abc");

		expect(identity).toEqual({ login: "octocat", scopes: ["repo", "read:org"] });
	});

	it("returns no scopes for a fine-grained token (no x-oauth-scopes header)", async () => {
		mockFetch({
			ok: true,
			status: 200,
			headers: new Headers(),
			json: async () => ({ login: "octocat" }),
		});

		const identity = await fetchAuthenticatedUser("github_pat_abc");

		expect(identity.scopes).toEqual([]);
	});

	it("throws InvalidTokenError on a 401", async () => {
		mockFetch({
			ok: false,
			status: 401,
			headers: new Headers(),
			json: async () => ({}),
		});

		await expect(fetchAuthenticatedUser("bad-token")).rejects.toBeInstanceOf(InvalidTokenError);
	});

	it("throws a generic error on other non-OK statuses", async () => {
		mockFetch({
			ok: false,
			status: 500,
			headers: new Headers(),
			json: async () => ({}),
		});

		await expect(fetchAuthenticatedUser("token")).rejects.toThrow("GitHub returned 500");
	});
});
