import { describe, it, expect, afterEach, jest } from "@jest/globals";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import type { Server } from "node:http";
import { llmAccountRouter } from "../../src/interface/server/routes/llmAccount.js";
import { saveAccount, loadAccount } from "../../src/engine/llm/account.js";
import type { ConnectedLlmAccount } from "../../src/engine/llm/account.js";
import { createLlmAccountState } from "../../src/interface/server/llmAccountState.js";
import type { LlmAccountState } from "../../src/interface/server/llmAccountState.js";
import { LlmProviderHolder } from "../../src/engine/drift/effectList/providerHolder.js";
import type { ResolvedLlmProvider } from "../../src/interface/server/resolveLlmProvider.js";
import type { LlmProvider } from "../../src/engine/drift/effectList/provider.js";
import { errorHandler } from "../../src/interface/server/middleware/errors.js";

interface JsonResponse {
	status: number;
	body: Record<string, unknown>;
}

async function call(
	server: Server,
	method: string,
	path: string,
	body?: unknown,
	headers: Record<string, string> = {},
): Promise<JsonResponse> {
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("no address");
	const init: RequestInit = { method, headers: { "Content-Type": "application/json", ...headers } };
	if (body !== undefined) init.body = JSON.stringify(body);
	const res = await fetch(`http://127.0.0.1:${address.port}${path}`, init);
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function workingProvider(name: string): LlmProvider {
	return {
		modelKey: `stub:${name}`,
		supportsEmbeddings: false,
		calls: [],
		async complete() {
			return `${name} ok`;
		},
		async embed() {
			return [];
		},
	};
}

function failingProvider(message: string): LlmProvider {
	return {
		modelKey: "stub:failing",
		supportsEmbeddings: false,
		calls: [],
		async complete(): Promise<string> {
			throw new Error(message);
		},
		async embed() {
			return [];
		},
	};
}

// Simulates a key scoped/restricted to allow chat completion but not embeddings (e.g. a
// Gemini key permitted to call generateContent but not embedContent).
function embedRestrictedProvider(message: string): LlmProvider {
	return {
		modelKey: "stub:embed-restricted",
		supportsEmbeddings: true,
		calls: [],
		async complete() {
			return "ok";
		},
		async embed(): Promise<ReadonlyArray<number>> {
			throw new Error(message);
		},
	};
}

const ADMIN_HEADERS = { "X-Quire-Admin": "1" };

describe("llmAccountRouter", () => {
	let dir: string;
	let server: Server;

	afterEach(async () => {
		if (server) await new Promise((resolve) => server.close(resolve));
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	function setup(
		buildProvider: (account: ConnectedLlmAccount) => ResolvedLlmProvider,
		initialAccount: ConnectedLlmAccount | undefined = undefined,
		fallback: LlmProvider = workingProvider("stub-fallback"),
	): { accountPath: string; holder: LlmProviderHolder; state: LlmAccountState } {
		const accountPath = join(dir, "llm-account.json");
		const holder = new LlmProviderHolder(workingProvider("initial"));
		const state = createLlmAccountState(initialAccount);
		const app = express();
		app.use(express.json());
		app.use(
			"/account/llm",
			llmAccountRouter(state, accountPath, holder, buildProvider, () => ({
				provider: fallback,
				description: "fallback",
			})),
		);
		app.use(errorHandler);
		server = app.listen(0);
		return { accountPath, holder, state };
	}

	it("reports not connected when no account has been set up", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-llm-router-"));
		setup(() => ({ provider: workingProvider("anthropic"), description: "anthropic" }));
		await new Promise((resolve) => server.once("listening", resolve));

		const { status, body } = await call(server, "GET", "/account/llm/status");

		expect(status).toBe(200);
		expect(body).toEqual({ connected: false });
	});

	it("validates the key, persists the account, and swaps in the new provider on success", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-llm-router-"));
		const provider = workingProvider("anthropic");
		const { accountPath, holder } = setup(() => ({ provider, description: "anthropic" }));
		const setProviderSpy = jest.spyOn(holder, "setProvider");
		await new Promise((resolve) => server.once("listening", resolve));

		const { status, body } = await call(
			server,
			"POST",
			"/account/llm/connect",
			{ provider: "anthropic", apiKey: "sk-ant-abc" },
			ADMIN_HEADERS,
		);

		expect(status).toBe(200);
		expect(body).toEqual(expect.objectContaining({ connected: true, provider: "anthropic" }));
		expect(setProviderSpy).toHaveBeenCalledWith(provider);

		const persisted = JSON.parse(await readFile(accountPath, "utf8")) as Record<string, unknown>;
		expect(persisted["provider"]).toBe("anthropic");
		expect(persisted["apiKey"]).toBe("sk-ant-abc");

		const statusResult = await call(server, "GET", "/account/llm/status");
		expect(statusResult.body).toEqual(expect.objectContaining({ connected: true, provider: "anthropic" }));
	});

	it("rejects a key that fails the live validation call, without persisting or swapping", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-llm-router-"));
		const { accountPath, holder } = setup(() => ({
			provider: failingProvider("Anthropic API error 401: invalid x-api-key"),
			description: "anthropic",
		}));
		const setProviderSpy = jest.spyOn(holder, "setProvider");
		await new Promise((resolve) => server.once("listening", resolve));

		const { status, body } = await call(
			server,
			"POST",
			"/account/llm/connect",
			{ provider: "anthropic", apiKey: "sk-ant-bad" },
			ADMIN_HEADERS,
		);

		expect(status).toBe(400);
		expect(body["error"]).toContain("invalid x-api-key");
		expect(setProviderSpy).not.toHaveBeenCalled();
		await expect(readFile(accountPath, "utf8")).rejects.toThrow();
	});

	it("does not swap the provider/state when saveAccount fails, so a persist failure can't leave an unpersisted key silently active", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-llm-router-"));
		// Force saveAccount to fail: make the account path's parent a file, not a
		// directory, so writeJsonFileAtomic's mkdir(dirname(path), {recursive:true}) throws.
		const blockerPath = join(dir, "blocker");
		await writeFile(blockerPath, "not a directory");
		const badAccountPath = join(blockerPath, "llm-account.json");

		const provider = workingProvider("anthropic");
		const holder = new LlmProviderHolder(workingProvider("initial"));
		const setProviderSpy = jest.spyOn(holder, "setProvider");
		const state = createLlmAccountState(undefined);
		const app = express();
		app.use(express.json());
		app.use(
			"/account/llm",
			llmAccountRouter(
				state,
				badAccountPath,
				holder,
				() => ({ provider, description: "anthropic" }),
				() => ({ provider: workingProvider("fallback"), description: "fallback" }),
			),
		);
		app.use(errorHandler);
		server = app.listen(0);
		await new Promise((resolve) => server.once("listening", resolve));

		const { status } = await call(
			server,
			"POST",
			"/account/llm/connect",
			{ provider: "anthropic", apiKey: "sk-ant-abc" },
			ADMIN_HEADERS,
		);

		expect(status).toBe(500);
		expect(setProviderSpy).not.toHaveBeenCalled();
		expect(state.current).toBeUndefined();
	});

	it("rejects a key that fails embed() validation even though complete() succeeds, without persisting or swapping", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-llm-router-"));
		const { accountPath, holder } = setup(() => ({
			provider: embedRestrictedProvider("Gemini API error 403: embedContent not permitted for this key"),
			description: "gemini",
		}));
		const setProviderSpy = jest.spyOn(holder, "setProvider");
		await new Promise((resolve) => server.once("listening", resolve));

		const { status, body } = await call(
			server,
			"POST",
			"/account/llm/connect",
			{ provider: "gemini", apiKey: "gk-restricted" },
			ADMIN_HEADERS,
		);

		expect(status).toBe(400);
		expect(body["error"]).toContain("embedContent not permitted");
		expect(setProviderSpy).not.toHaveBeenCalled();
		await expect(readFile(accountPath, "utf8")).rejects.toThrow();
	});

	it("serializes concurrent connect requests so the in-memory holder and the persisted file never disagree on which provider is active", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-llm-router-"));
		const anthropicProvider = workingProvider("anthropic");
		const geminiProvider = workingProvider("gemini");
		const { accountPath, holder } = setup((account) => ({
			provider: account.provider === "anthropic" ? anthropicProvider : geminiProvider,
			description: account.provider,
		}));
		await new Promise((resolve) => server.once("listening", resolve));

		const [r1, r2] = await Promise.all([
			call(server, "POST", "/account/llm/connect", { provider: "anthropic", apiKey: "sk-ant-1" }, ADMIN_HEADERS),
			call(server, "POST", "/account/llm/connect", { provider: "gemini", apiKey: "gk-1" }, ADMIN_HEADERS),
		]);

		expect(r1.status).toBe(200);
		expect(r2.status).toBe(200);

		const persisted = await loadAccount(accountPath);
		expect(persisted).toBeDefined();
		const liveResponse = await holder.complete([{ role: "user", content: "check" }]);
		expect(liveResponse).toBe(`${persisted?.provider} ok`);
	});

	it("rejects connect attempts missing the admin header (CSRF guard) without storing anything", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-llm-router-"));
		const { accountPath } = setup(() => ({ provider: workingProvider("anthropic"), description: "anthropic" }));
		await new Promise((resolve) => server.once("listening", resolve));

		const { status } = await call(
			server,
			"POST",
			"/account/llm/connect",
			{ provider: "anthropic", apiKey: "sk-ant-abc" },
			{},
		);

		expect(status).toBe(403);
		await expect(readFile(accountPath, "utf8")).rejects.toThrow();
	});

	it("disconnects, clears the persisted account, and falls back to the injected resolver", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-llm-router-"));
		const existing: ConnectedLlmAccount = { provider: "gemini", apiKey: "gk-1", connectedAt: "now" };
		const fallback = workingProvider("env-fallback");
		const { accountPath, holder } = setup(
			() => ({ provider: workingProvider("gemini"), description: "gemini" }),
			existing,
			fallback,
		);
		const setProviderSpy = jest.spyOn(holder, "setProvider");
		await new Promise((resolve) => server.once("listening", resolve));
		await saveAccount(accountPath, existing);

		const { status, body } = await call(server, "POST", "/account/llm/disconnect", undefined, ADMIN_HEADERS);

		expect(status).toBe(200);
		expect(body).toEqual({ connected: false });
		expect(setProviderSpy).toHaveBeenCalledWith(fallback);
		expect(await loadAccount(accountPath)).toBeUndefined();

		const statusResult = await call(server, "GET", "/account/llm/status");
		expect(statusResult.body).toEqual({ connected: false });
	});

	it("does not clear state or the persisted file when the fallback resolver throws", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-llm-router-"));
		const existing: ConnectedLlmAccount = { provider: "anthropic", apiKey: "sk-1", connectedAt: "now" };
		const holder = new LlmProviderHolder(workingProvider("anthropic"));
		const setProviderSpy = jest.spyOn(holder, "setProvider");
		const state = createLlmAccountState(existing);
		const accountPath = join(dir, "llm-account.json");
		await saveAccount(accountPath, existing);

		const app = express();
		app.use(express.json());
		app.use(
			"/account/llm",
			llmAccountRouter(
				state,
				accountPath,
				holder,
				() => ({ provider: workingProvider("anthropic"), description: "anthropic" }),
				() => {
					throw new Error("LLM_PROVIDER=anthropic requires ANTHROPIC_API_KEY to be set");
				},
			),
		);
		app.use(errorHandler);
		server = app.listen(0);
		await new Promise((resolve) => server.once("listening", resolve));

		const { status } = await call(server, "POST", "/account/llm/disconnect", undefined, ADMIN_HEADERS);

		expect(status).toBe(500);
		expect(setProviderSpy).not.toHaveBeenCalled();
		expect(state.current).toEqual(existing);
		expect(await loadAccount(accountPath)).toEqual(existing);
	});

	it("rejects disconnect attempts missing the admin header", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-llm-router-"));
		setup(() => ({ provider: workingProvider("anthropic"), description: "anthropic" }));
		await new Promise((resolve) => server.once("listening", resolve));

		const { status } = await call(server, "POST", "/account/llm/disconnect", undefined, {});

		expect(status).toBe(403);
	});
});
