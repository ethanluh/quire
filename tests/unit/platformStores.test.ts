import { describe, it, expect, afterEach } from "@jest/globals";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlatformAllowlistStore } from "../../src/engine/platform/platformAllowlistStore.js";
import { PlatformGateDefaultsStore } from "../../src/engine/platform/platformGateDefaultsStore.js";

describe("PlatformAllowlistStore", () => {
	let dir: string;

	afterEach(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	it("starts empty before load() finds a file", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-platform-allowlist-"));
		const store = new PlatformAllowlistStore(join(dir, "allowed-logins.json"));
		await store.load();
		expect(store.get()).toEqual([]);
	});

	it("normalizes (lowercase, trim, dedupe) and persists across a fresh load()", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-platform-allowlist-"));
		const path = join(dir, "allowed-logins.json");
		const store = new PlatformAllowlistStore(path);
		await store.load();
		await store.set([" Alice ", "bob", "ALICE"]);
		expect(store.get()).toEqual(["alice", "bob"]);

		const reloaded = new PlatformAllowlistStore(path);
		await reloaded.load();
		expect(reloaded.get()).toEqual(["alice", "bob"]);
	});
});

describe("PlatformGateDefaultsStore", () => {
	let dir: string;

	afterEach(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	it("has no criteria before anything is ever set", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-platform-gate-"));
		const store = new PlatformGateDefaultsStore(join(dir, "gate-config.json"));
		await store.load();
		expect(store.get()).toBeUndefined();
	});

	it("persists set() and survives a fresh load()", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-platform-gate-"));
		const path = join(dir, "gate-config.json");
		const store = new PlatformGateDefaultsStore(path);
		await store.load();
		await store.set([{ name: "buildFailure", mode: "enforce" }]);

		const reloaded = new PlatformGateDefaultsStore(path);
		await reloaded.load();
		expect(reloaded.get()).toEqual([{ name: "buildFailure", mode: "enforce" }]);
	});
});
