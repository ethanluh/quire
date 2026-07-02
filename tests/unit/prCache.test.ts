import { describe, it, expect, afterEach } from "@jest/globals";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrEffectCache } from "../../src/engine/cache/prCache.js";

describe("PrEffectCache — effects", () => {
	it("misses for a PR that was never cached", () => {
		const cache = new PrEffectCache();
		expect(cache.getEffects("pr-1", "sha-1")).toBeUndefined();
	});

	it("hits when the headSha matches what was cached", async () => {
		const cache = new PrEffectCache();
		await cache.putEffects("pr-1", "sha-1", "org", "repo", ["adds OTP login"]);
		expect(cache.getEffects("pr-1", "sha-1")).toEqual(["adds OTP login"]);
	});

	it("misses when the headSha has changed since caching (new commits pushed)", async () => {
		const cache = new PrEffectCache();
		await cache.putEffects("pr-1", "sha-1", "org", "repo", ["adds OTP login"]);
		expect(cache.getEffects("pr-1", "sha-2")).toBeUndefined();
	});

	it("overwrites the prior entry when re-put with a new headSha", async () => {
		const cache = new PrEffectCache();
		await cache.putEffects("pr-1", "sha-1", "org", "repo", ["adds OTP login"]);
		await cache.putEffects("pr-1", "sha-2", "org", "repo", ["adds passkey support"]);
		expect(cache.getEffects("pr-1", "sha-1")).toBeUndefined();
		expect(cache.getEffects("pr-1", "sha-2")).toEqual(["adds passkey support"]);
	});
});

describe("PrEffectCache — evictStaleForRepo", () => {
	it("drops entries for PR ids no longer present in liveIds, scoped to one repo", async () => {
		const cache = new PrEffectCache();
		await cache.putEffects("pr-1", "sha-1", "org", "repo-a", ["effect a"]);
		await cache.putEffects("pr-2", "sha-1", "org", "repo-a", ["effect b"]);
		await cache.putEffects("pr-3", "sha-1", "org", "repo-b", ["effect c"]);

		await cache.evictStaleForRepo("org", "repo-a", new Set(["pr-1"]));

		expect(cache.getEffects("pr-1", "sha-1")).toEqual(["effect a"]);
		expect(cache.getEffects("pr-2", "sha-1")).toBeUndefined();
		// A different repo's entries are never touched by another repo's eviction pass.
		expect(cache.getEffects("pr-3", "sha-1")).toEqual(["effect c"]);
	});
});

describe("PrEffectCache — embeddings", () => {
	it("misses for text that was never embedded", () => {
		const cache = new PrEffectCache();
		expect(cache.getEmbedding("adds OTP login")).toBeUndefined();
	});

	it("hits for identical text, keyed on content not identity", async () => {
		const cache = new PrEffectCache();
		await cache.putEmbedding("adds OTP login", [0.1, 0.2, 0.3]);
		expect(cache.getEmbedding("adds OTP login")).toEqual([0.1, 0.2, 0.3]);
		expect(cache.getEmbedding("adds otp login")).toBeUndefined();
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
		await writer.putEffects("pr-1", "sha-1", "org", "repo", ["adds OTP login"]);
		await writer.putEmbedding("adds OTP login", [0.1, 0.2]);

		const reader = new PrEffectCache(statePath);
		await reader.load();
		expect(reader.getEffects("pr-1", "sha-1")).toEqual(["adds OTP login"]);
		expect(reader.getEmbedding("adds OTP login")).toEqual([0.1, 0.2]);
	});

	it("treats a missing state file as an empty cache rather than an error", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-pr-cache-"));
		const cache = new PrEffectCache(join(dir, "does-not-exist.json"));
		await cache.load();
		expect(cache.getEffects("pr-1", "sha-1")).toBeUndefined();
	});

	it("without a statePath, never touches disk and stays scoped to the instance", async () => {
		const cache = new PrEffectCache();
		await cache.load();
		await cache.putEffects("pr-1", "sha-1", "org", "repo", ["adds OTP login"]);
		expect(new PrEffectCache().getEffects("pr-1", "sha-1")).toBeUndefined();
	});
});
