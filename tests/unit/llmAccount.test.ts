import { describe, it, expect, afterEach } from "@jest/globals";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAccount, saveAccount, clearAccount } from "../../src/engine/llm/account.js";
import type { ConnectedLlmAccount } from "../../src/engine/llm/account.js";

describe("llm account persistence", () => {
	let dir: string;

	afterEach(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	it("returns undefined when no account file exists", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-llm-account-"));
		const account = await loadAccount(join(dir, "llm-account.json"));
		expect(account).toBeUndefined();
	});

	it("round-trips a saved account, creating parent dirs as needed", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-llm-account-"));
		const path = join(dir, "nested", "llm-account.json");
		const account: ConnectedLlmAccount = {
			provider: "anthropic",
			apiKey: "sk-ant-abc123",
			connectedAt: "2026-06-30T00:00:00.000Z",
		};

		await saveAccount(path, account);
		const loaded = await loadAccount(path);

		expect(loaded).toEqual(account);
	});

	it("treats a corrupted file as not connected", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-llm-account-"));
		const path = join(dir, "llm-account.json");
		await saveAccount(path, { provider: "gemini", apiKey: "gk-1", connectedAt: "now" });
		await rm(path);
		const { writeFile } = await import("node:fs/promises");
		await writeFile(path, "not json", "utf8");

		const loaded = await loadAccount(path);

		expect(loaded).toBeUndefined();
	});

	it("treats an unrecognized provider value as not connected", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-llm-account-"));
		const path = join(dir, "llm-account.json");
		const { writeFile } = await import("node:fs/promises");
		await writeFile(path, JSON.stringify({ provider: "openai", apiKey: "x", connectedAt: "now" }), "utf8");

		const loaded = await loadAccount(path);

		expect(loaded).toBeUndefined();
	});

	it("clearAccount removes the file without throwing if it never existed", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-llm-account-"));
		const path = join(dir, "llm-account.json");
		await saveAccount(path, { provider: "anthropic", apiKey: "sk-1", connectedAt: "now" });

		await clearAccount(path);
		await expect(clearAccount(path)).resolves.toBeUndefined();
		expect(await loadAccount(path)).toBeUndefined();
	});
});
