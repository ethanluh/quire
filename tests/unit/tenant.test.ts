import { describe, it, expect, afterEach } from "@jest/globals";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TenantRegistry } from "../../src/interface/server/tenant.js";
import type { TenantSharedConfig } from "../../src/interface/server/tenant.js";
import { StubStaticAnalyzer } from "../mocks/staticAnalyzer.js";
import { StubLlmProvider } from "../mocks/llmProvider.js";
import { createUserTokenCache } from "../../src/engine/github/userTokenCache.js";
import type { InstallationBinding } from "../../src/engine/github/installation.js";
import type { PipelineConfig } from "../../src/engine/pipeline/pipeline.js";

const PIPELINE_CONFIG: PipelineConfig = {
	gate: { criteria: [{ name: "buildFailure", mode: "enforce" }] },
	bundle: { similarityThreshold: 0.75 },
};

function binding(overrides: Partial<InstallationBinding> = {}): InstallationBinding {
	return {
		installationId: 1,
		accountLogin: "acme-corp",
		accountType: "Organization",
		boundAt: "2026-06-30T00:00:00.000Z",
		...overrides,
	};
}

describe("TenantRegistry", () => {
	let dir: string;

	afterEach(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	function makeRegistry(): TenantRegistry {
		const shared: TenantSharedConfig = {
			dataDir: dir,
			appConfig: { appId: "1", privateKey: "unused" },
			appSlug: "quire-review",
			pipelineConfig: PIPELINE_CONFIG,
			analyzer: new StubStaticAnalyzer(),
			isProduction: false,
			resolveDefaultLlmProvider: () => ({ provider: new StubLlmProvider(), description: "stub" }),
			userTokenCache: createUserTokenCache(),
			enrichWithUserToken: async (repos) => repos,
		};
		return new TenantRegistry(shared);
	}

	it("gives two different logins fully independent contexts", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-tenant-"));
		const registry = makeRegistry();

		const alice = await registry.getOrCreate("alice");
		const bob = await registry.getOrCreate("bob");

		expect(alice).not.toBe(bob);
		expect(alice.accountState).not.toBe(bob.accountState);
		expect(alice.clientHolder).not.toBe(bob.clientHolder);
		expect(alice.state).not.toBe(bob.state);
		expect(alice.queue).not.toBe(bob.queue);
	});

	it("returns the same cached context on repeated getOrCreate calls for one login", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-tenant-"));
		const registry = makeRegistry();

		const first = await registry.getOrCreate("alice");
		const second = await registry.getOrCreate("alice");

		expect(first).toBe(second);
	});

	it("binding an installation for one tenant never touches another tenant's state or files", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-tenant-"));
		const registry = makeRegistry();

		const alice = await registry.getOrCreate("alice");
		const bob = await registry.getOrCreate("bob");

		alice.accountState.current = binding({ installationId: 111, accountLogin: "alice-org" });

		expect(bob.accountState.current).toBeUndefined();

		// The in-memory mutation above never went through a route handler's saveInstallation
		// call, so neither tenant's file exists yet — this just confirms bob's directory was
		// never touched by alice's mutation.
		expect(existsSync(join(dir, "users", "alice", "installation.json"))).toBe(false);
		expect(existsSync(join(dir, "users", "bob", "installation.json"))).toBe(false);
	});

	it("loads each tenant's own persisted installation.json from its own directory", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-tenant-"));
		const registry = makeRegistry();

		// Simulate a prior process having bound an installation for alice by writing
		// straight to disk, then verify a fresh registry only loads it for alice.
		const { writeJsonFileAtomic } = await import("../../src/engine/jsonFile.js");
		await writeJsonFileAtomic(join(dir, "users", "alice", "installation.json"), binding({ installationId: 222 }));

		const alice = await registry.getOrCreate("alice");
		const bob = await registry.getOrCreate("bob");

		expect(alice.accountState.current?.installationId).toBe(222);
		expect(bob.accountState.current).toBeUndefined();
	});

	it("findByInstallationId routes to the tenant that owns that installation, not any other", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-tenant-"));
		const registry = makeRegistry();

		const alice = await registry.getOrCreate("alice");
		const bob = await registry.getOrCreate("bob");
		alice.accountState.current = binding({ installationId: 111 });
		bob.accountState.current = binding({ installationId: 222 });

		expect(registry.findByInstallationId(111)?.login).toBe("alice");
		expect(registry.findByInstallationId(222)?.login).toBe("bob");
		expect(registry.findByInstallationId(999)).toBeUndefined();
	});

	it("hydrateExisting loads every tenant directory already on disk without a prior request", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-tenant-"));
		const { writeJsonFileAtomic } = await import("../../src/engine/jsonFile.js");
		await writeJsonFileAtomic(join(dir, "users", "alice", "installation.json"), binding({ installationId: 333 }));
		await writeJsonFileAtomic(join(dir, "users", "bob", "installation.json"), binding({ installationId: 444 }));

		const registry = makeRegistry();
		await registry.hydrateExisting();

		expect(registry.all().map((t) => t.login).sort()).toEqual(["alice", "bob"]);
		expect(registry.findByInstallationId(333)?.login).toBe("alice");
		expect(registry.findByInstallationId(444)?.login).toBe("bob");
	});

	it("rejects a login that doesn't look like a real GitHub username before touching the filesystem", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-tenant-"));
		const registry = makeRegistry();

		await expect(registry.getOrCreate("../../etc/passwd")).rejects.toThrow();
	});
});
