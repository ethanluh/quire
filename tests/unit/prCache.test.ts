import { describe, it, expect, afterEach, jest } from "@jest/globals";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrEffectCache } from "../../src/engine/cache/prCache.js";

const MODEL_A = "anthropic:claude-haiku-4-5";
const MODEL_B = "gemini:gemma-4-31b-it+gemini-embedding-001";

describe("PrEffectCache — effects", () => {
	it("misses for a PR that was never cached", () => {
		const cache = new PrEffectCache();
		expect(cache.getEffects("pr-1", "sha-1", MODEL_A)).toBeUndefined();
	});

	it("hits when the headSha and modelKey match what was cached", () => {
		const cache = new PrEffectCache();
		cache.putEffects("pr-1", "sha-1", "org", "repo", ["adds OTP login"], MODEL_A);
		expect(cache.getEffects("pr-1", "sha-1", MODEL_A)).toEqual(["adds OTP login"]);
	});

	it("misses when the headSha has changed since caching (new commits pushed)", () => {
		const cache = new PrEffectCache();
		cache.putEffects("pr-1", "sha-1", "org", "repo", ["adds OTP login"], MODEL_A);
		expect(cache.getEffects("pr-1", "sha-2", MODEL_A)).toBeUndefined();
	});

	it("misses when the modelKey has changed (LLM provider/model switched)", () => {
		const cache = new PrEffectCache();
		cache.putEffects("pr-1", "sha-1", "org", "repo", ["adds OTP login"], MODEL_A);
		// Same PR, same commit, but a different provider/model produced the cached
		// entry — must not silently serve effects extracted by the old one.
		expect(cache.getEffects("pr-1", "sha-1", MODEL_B)).toBeUndefined();
	});

	it("overwrites the prior entry when re-put with a new headSha", () => {
		const cache = new PrEffectCache();
		cache.putEffects("pr-1", "sha-1", "org", "repo", ["adds OTP login"], MODEL_A);
		cache.putEffects("pr-1", "sha-2", "org", "repo", ["adds passkey support"], MODEL_A);
		expect(cache.getEffects("pr-1", "sha-1", MODEL_A)).toBeUndefined();
		expect(cache.getEffects("pr-1", "sha-2", MODEL_A)).toEqual(["adds passkey support"]);
	});
});

describe("PrEffectCache — evictStaleForRepo", () => {
	it("drops entries for PR ids no longer present in liveIds, scoped to one repo", async () => {
		const cache = new PrEffectCache();
		cache.putEffects("pr-1", "sha-1", "org", "repo-a", ["effect a"], MODEL_A);
		cache.putEffects("pr-2", "sha-1", "org", "repo-a", ["effect b"], MODEL_A);
		cache.putEffects("pr-3", "sha-1", "org", "repo-b", ["effect c"], MODEL_A);

		await cache.evictStaleForRepo("org", "repo-a", new Set(["pr-1"]));

		expect(cache.getEffects("pr-1", "sha-1", MODEL_A)).toEqual(["effect a"]);
		expect(cache.getEffects("pr-2", "sha-1", MODEL_A)).toBeUndefined();
		// A different repo's entries are never touched by another repo's eviction pass.
		expect(cache.getEffects("pr-3", "sha-1", MODEL_A)).toEqual(["effect c"]);
	});
});

describe("PrEffectCache — embeddings", () => {
	it("misses for text that was never embedded", () => {
		const cache = new PrEffectCache();
		expect(cache.getEmbedding("adds OTP login", MODEL_A)).toBeUndefined();
	});

	it("hits for identical text and modelKey, keyed on content not identity", () => {
		const cache = new PrEffectCache();
		cache.putEmbedding("adds OTP login", [0.1, 0.2, 0.3], MODEL_A);
		expect(cache.getEmbedding("adds OTP login", MODEL_A)).toEqual([0.1, 0.2, 0.3]);
		expect(cache.getEmbedding("adds otp login", MODEL_A)).toBeUndefined();
	});

	it("misses when the modelKey has changed (embedding provider/model switched)", () => {
		const cache = new PrEffectCache();
		cache.putEmbedding("adds OTP login", [0.1, 0.2, 0.3], MODEL_A);
		expect(cache.getEmbedding("adds OTP login", MODEL_B)).toBeUndefined();
	});
});

describe("PrEffectCache — persistence", () => {
	let dir: string;

	afterEach(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	it("round-trips effects and embeddings across separate instances via the same statePath", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-pr-cache-"));
		const statePath = join(dir, "pr-cache.json");

		const writer = new PrEffectCache(statePath);
		await writer.load();
		writer.putEffects("pr-1", "sha-1", "org", "repo", ["adds OTP login"], MODEL_A);
		writer.putEmbedding("adds OTP login", [0.1, 0.2], MODEL_A);
		await writer.save();

		const reader = new PrEffectCache(statePath);
		await reader.load();
		expect(reader.getEffects("pr-1", "sha-1", MODEL_A)).toEqual(["adds OTP login"]);
		expect(reader.getEmbedding("adds OTP login", MODEL_A)).toEqual([0.1, 0.2]);
	});

	it("treats a missing state file as an empty cache rather than an error", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-pr-cache-"));
		const cache = new PrEffectCache(join(dir, "does-not-exist.json"));
		await cache.load();
		expect(cache.getEffects("pr-1", "sha-1", MODEL_A)).toBeUndefined();
	});

	it("without a statePath, never touches disk and stays scoped to the instance", async () => {
		const cache = new PrEffectCache();
		await cache.load();
		cache.putEffects("pr-1", "sha-1", "org", "repo", ["adds OTP login"], MODEL_A);
		await cache.save();
		expect(new PrEffectCache().getEffects("pr-1", "sha-1", MODEL_A)).toBeUndefined();
	});

	it("save() is a no-op when nothing was mutated since the last save", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-pr-cache-"));
		const statePath = join(dir, "pr-cache.json");
		const cache = new PrEffectCache(statePath);
		await cache.load();
		cache.putEffects("pr-1", "sha-1", "org", "repo", ["adds OTP login"], MODEL_A);
		await cache.save();
		// A second save with no intervening mutation should not throw or hang, and the
		// persisted data should be unchanged.
		await cache.save();

		const reader = new PrEffectCache(statePath);
		await reader.load();
		expect(reader.getEffects("pr-1", "sha-1", MODEL_A)).toEqual(["adds OTP login"]);
	});

	it("serializes concurrent save() calls instead of racing writes to the same file", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-pr-cache-"));
		const statePath = join(dir, "pr-cache.json");
		const cache = new PrEffectCache(statePath);
		await cache.load();

		// Simulates clusterPRs' 4-way concurrent embedding puts, or two repos' refreshes
		// sharing one server-wide instance — each mutates then calls save() without
		// awaiting the previous call first.
		const writes = Array.from({ length: 8 }, (_, i) => {
			cache.putEffects(`pr-${i}`, "sha-1", "org", "repo", [`effect ${i}`], MODEL_A);
			return cache.save();
		});
		await Promise.all(writes);

		const reader = new PrEffectCache(statePath);
		await reader.load();
		for (let i = 0; i < 8; i++) {
			expect(reader.getEffects(`pr-${i}`, "sha-1", MODEL_A)).toEqual([`effect ${i}`]);
		}
	});

	it("recovers after a failed write: save() neither throws nor poisons the chain, and retries the data", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-pr-cache-"));
		// A file where the statePath's parent directory should be forces the write to fail —
		// simulating a transient disk error (ENOSPC/EIO) during a refresh.
		const blocker = join(dir, "blocker");
		await writeFile(blocker, "not a directory", "utf8");
		const statePath = join(blocker, "pr-cache.json");

		const errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
		try {
			const cache = new PrEffectCache(statePath);
			cache.putEffects("pr-1", "sha-1", "org", "repo", ["adds OTP login"], MODEL_A);
			// Must not throw: the cache is an optimization, and this save() sits on the
			// ingestion path (refreshRepoQueue awaits evictStaleForRepo → save) — a transient
			// write failure aborting every future refresh until restart is the regression.
			await cache.save();

			// Disk recovers: the next save must actually write (the failed snapshot's dirty
			// bit was restored), not no-op off a permanently rejected write chain.
			await rm(blocker);
			await cache.save();

			const reader = new PrEffectCache(statePath);
			await reader.load();
			expect(reader.getEffects("pr-1", "sha-1", MODEL_A)).toEqual(["adds OTP login"]);
		} finally {
			errorSpy.mockRestore();
		}
	});
});
