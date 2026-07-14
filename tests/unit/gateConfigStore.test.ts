import { describe, it, expect, afterEach } from "@jest/globals";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GateConfigStore, resolveEffectiveGateConfig } from "../../src/engine/gate/gateConfigStore.js";
import type { GateCriterion } from "../../src/engine/types/gate.js";

const PLATFORM_DEFAULT: ReadonlyArray<GateCriterion> = [
	{ name: "buildFailure", mode: "enforce" },
	{ name: "outOfScope", mode: "off" },
	{ name: "duplicate", mode: "shadow" },
];

describe("resolveEffectiveGateConfig", () => {
	it("returns the platform default untouched when there is no override", () => {
		expect(resolveEffectiveGateConfig(PLATFORM_DEFAULT, undefined)).toEqual(PLATFORM_DEFAULT);
	});

	it("lets an override win only for the criterion names it lists", () => {
		const effective = resolveEffectiveGateConfig(PLATFORM_DEFAULT, { criteria: [{ name: "outOfScope", mode: "enforce" }] });
		expect(effective).toEqual([
			{ name: "buildFailure", mode: "enforce" },
			{ name: "outOfScope", mode: "enforce" },
			{ name: "duplicate", mode: "shadow" },
		]);
	});

	it("treats an override with an empty criteria list as fully inheriting the default", () => {
		expect(resolveEffectiveGateConfig(PLATFORM_DEFAULT, { criteria: [] })).toEqual(PLATFORM_DEFAULT);
	});
});

describe("GateConfigStore", () => {
	let dir: string;

	afterEach(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	it("has no override before load() finds a file", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-gate-config-"));
		const store = new GateConfigStore(join(dir, "gate-config.json"));
		await store.load();
		expect(store.get()).toBeUndefined();
	});

	it("persists set() and survives a fresh load() (process restart)", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-gate-config-"));
		const path = join(dir, "gate-config.json");
		const store = new GateConfigStore(path);
		await store.load();
		await store.set({ criteria: [{ name: "duplicate", mode: "off" }] });
		expect(store.get()).toEqual({ criteria: [{ name: "duplicate", mode: "off" }] });

		const reloaded = new GateConfigStore(path);
		await reloaded.load();
		expect(reloaded.get()).toEqual({ criteria: [{ name: "duplicate", mode: "off" }] });
	});
});
