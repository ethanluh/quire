import { describe, it, expect, afterEach, jest } from "@jest/globals";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureValidAccessToken, NeedsReconnectError } from "../../src/engine/github/tokenRefresh.js";
import { GitHubClientHolder } from "../../src/engine/github/clientHolder.js";
import { OctokitGitHubClient } from "../../src/engine/github/octokitClient.js";
import { StubGitHubClient } from "../../src/engine/github/stubClient.js";
import type { ConnectedAccount } from "../../src/engine/github/account.js";
import type { OAuthDeps } from "../../src/engine/github/oauth.js";

const BASE_ACCOUNT: ConnectedAccount = {
	login: "octocat",
	token: "old-token",
	scopes: [],
	connectedAt: "2026-06-30T00:00:00.000Z",
};

function makeOAuth(overrides: Partial<OAuthDeps> = {}): OAuthDeps {
	return {
		config: { clientId: "id", clientSecret: "secret" },
		buildAuthorizeUrl: () => "",
		exchangeCodeForToken: async () => ({ accessToken: "unused" }),
		refreshAccessToken: async () => ({ accessToken: "new-token", refreshToken: "refresh-2" }),
		redirectUri: "http://localhost:3000/callback",
		...overrides,
	};
}

describe("ensureValidAccessToken", () => {
	let dir: string;

	afterEach(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	it("returns the account unchanged when tokenExpiresAt is unset (PAT or non-expiring OAuth token)", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-token-refresh-"));
		const clientHolder = new GitHubClientHolder(new StubGitHubClient());
		const setClientSpy = jest.spyOn(clientHolder, "setClient");

		const result = await ensureValidAccessToken(BASE_ACCOUNT, {
			accountPath: join(dir, "github-account.json"),
			clientHolder,
			oauth: undefined,
		});

		expect(result).toEqual(BASE_ACCOUNT);
		expect(setClientSpy).not.toHaveBeenCalled();
	});

	it("returns the account unchanged when tokenExpiresAt is comfortably in the future", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-token-refresh-"));
		const account: ConnectedAccount = {
			...BASE_ACCOUNT,
			tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
		};
		const clientHolder = new GitHubClientHolder(new StubGitHubClient());

		const result = await ensureValidAccessToken(account, {
			accountPath: join(dir, "github-account.json"),
			clientHolder,
			oauth: makeOAuth(),
		});

		expect(result.token).toBe("old-token");
	});

	it("refreshes an about-to-expire token, persists it, and swaps in a real authenticated client", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-token-refresh-"));
		const accountPath = join(dir, "github-account.json");
		const account: ConnectedAccount = {
			...BASE_ACCOUNT,
			refreshToken: "refresh-1",
			tokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
		};
		const clientHolder = new GitHubClientHolder(new StubGitHubClient());
		const setClientSpy = jest.spyOn(clientHolder, "setClient");

		const result = await ensureValidAccessToken(account, { accountPath, clientHolder, oauth: makeOAuth() });

		expect(result.token).toBe("new-token");
		expect(result.refreshToken).toBe("refresh-2");
		expect(result.needsReconnect).toBe(false);
		expect(setClientSpy).toHaveBeenCalledTimes(1);
		expect(setClientSpy.mock.calls[0]?.[0]).toBeInstanceOf(OctokitGitHubClient);

		const persisted = JSON.parse(await readFile(accountPath, "utf8")) as Record<string, unknown>;
		expect(persisted["token"]).toBe("new-token");
	});

	it("keeps the old refresh token when GitHub doesn't rotate it", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-token-refresh-"));
		const account: ConnectedAccount = {
			...BASE_ACCOUNT,
			refreshToken: "refresh-1",
			tokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
		};
		const oauth = makeOAuth({ refreshAccessToken: async () => ({ accessToken: "new-token" }) });
		const clientHolder = new GitHubClientHolder(new StubGitHubClient());

		const result = await ensureValidAccessToken(account, {
			accountPath: join(dir, "github-account.json"),
			clientHolder,
			oauth,
		});

		expect(result.refreshToken).toBe("refresh-1");
	});

	it("throws NeedsReconnectError and persists needsReconnect when there's no refresh token", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-token-refresh-"));
		const accountPath = join(dir, "github-account.json");
		const account: ConnectedAccount = { ...BASE_ACCOUNT, tokenExpiresAt: new Date(Date.now() - 1000).toISOString() };
		const clientHolder = new GitHubClientHolder(new StubGitHubClient());

		await expect(
			ensureValidAccessToken(account, { accountPath, clientHolder, oauth: makeOAuth() }),
		).rejects.toBeInstanceOf(NeedsReconnectError);

		const persisted = JSON.parse(await readFile(accountPath, "utf8")) as Record<string, unknown>;
		expect(persisted["needsReconnect"]).toBe(true);
	});

	it("throws NeedsReconnectError and persists needsReconnect when oauth isn't configured", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-token-refresh-"));
		const accountPath = join(dir, "github-account.json");
		const account: ConnectedAccount = {
			...BASE_ACCOUNT,
			refreshToken: "refresh-1",
			tokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
		};
		const clientHolder = new GitHubClientHolder(new StubGitHubClient());

		await expect(
			ensureValidAccessToken(account, { accountPath, clientHolder, oauth: undefined }),
		).rejects.toBeInstanceOf(NeedsReconnectError);

		const persisted = JSON.parse(await readFile(accountPath, "utf8")) as Record<string, unknown>;
		expect(persisted["needsReconnect"]).toBe(true);
	});

	it("throws NeedsReconnectError and persists needsReconnect when the refresh call itself fails", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-token-refresh-"));
		const accountPath = join(dir, "github-account.json");
		const account: ConnectedAccount = {
			...BASE_ACCOUNT,
			refreshToken: "refresh-1",
			tokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
		};
		const oauth = makeOAuth({
			refreshAccessToken: async () => {
				throw new Error("GitHub rejected the refresh token");
			},
		});
		const clientHolder = new GitHubClientHolder(new StubGitHubClient());

		await expect(
			ensureValidAccessToken(account, { accountPath, clientHolder, oauth }),
		).rejects.toBeInstanceOf(NeedsReconnectError);

		const persisted = JSON.parse(await readFile(accountPath, "utf8")) as Record<string, unknown>;
		expect(persisted["needsReconnect"]).toBe(true);
	});
});
