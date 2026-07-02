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
import type { InstallationAccountState, InstallationBinding } from "../../src/engine/github/installation.js";
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

// Each tenant's accountState.current is a full InstallationAccountState (installations[]
// plus the tenant-wide selectedRepo/autoMergeOnAccept/flagConflictsForFleet), not a single
// InstallationBinding — see accountState.ts.
function accountStateWith(...installations: ReadonlyArray<InstallationBinding>): InstallationAccountState {
	return { installations };
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

	it("gives two different teams fully independent contexts", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-tenant-"));
		const registry = makeRegistry();

		const alpha = await registry.getOrCreate("alpha");
		const bravo = await registry.getOrCreate("bravo");

		expect(alpha).not.toBe(bravo);
		expect(alpha.accountState).not.toBe(bravo.accountState);
		expect(alpha.clientHolder).not.toBe(bravo.clientHolder);
		expect(alpha.state).not.toBe(bravo.state);
		expect(alpha.queue).not.toBe(bravo.queue);
	});

	it("returns the same cached context on repeated getOrCreate calls for one team", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-tenant-"));
		const registry = makeRegistry();

		const first = await registry.getOrCreate("alpha");
		const second = await registry.getOrCreate("alpha");

		expect(first).toBe(second);
	});

	it("binding an installation for one team never touches another team's state or files", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-tenant-"));
		const registry = makeRegistry();

		const alpha = await registry.getOrCreate("alpha");
		const bravo = await registry.getOrCreate("bravo");

		alpha.accountState.current = accountStateWith(binding({ installationId: 111, accountLogin: "alpha-org" }));

		expect(bravo.accountState.current.installations).toEqual([]);

		// The in-memory mutation above never went through a route handler's saveInstallation
		// call, so neither team's file exists yet — this just confirms bravo's directory was
		// never touched by alpha's mutation.
		expect(existsSync(join(dir, "teams", "alpha", "installation.json"))).toBe(false);
		expect(existsSync(join(dir, "teams", "bravo", "installation.json"))).toBe(false);
	});

	it("loads each team's own persisted installation.json from its own directory", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-tenant-"));
		const registry = makeRegistry();

		// Simulate a prior process having bound an installation for alpha by writing
		// straight to disk, then verify a fresh registry only loads it for alpha.
		const { writeJsonFileAtomic } = await import("../../src/engine/jsonFile.js");
		await writeJsonFileAtomic(join(dir, "teams", "alpha", "installation.json"), accountStateWith(binding({ installationId: 222 })));

		const alpha = await registry.getOrCreate("alpha");
		const bravo = await registry.getOrCreate("bravo");

		expect(alpha.accountState.current.installations.map((i) => i.installationId)).toEqual([222]);
		expect(bravo.accountState.current.installations).toEqual([]);
	});

	it("one tenant can bind several installations, all showing up under that same tenant", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-tenant-"));
		const registry = makeRegistry();

		const alpha = await registry.getOrCreate("alpha");
		alpha.accountState.current = accountStateWith(
			binding({ installationId: 111, accountLogin: "alpha-personal" }),
			binding({ installationId: 222, accountLogin: "alpha-org", accountType: "Organization" }),
		);

		expect(alpha.accountState.current.installations.map((i) => i.installationId)).toEqual([111, 222]);
		expect(registry.findByInstallationId(111)?.teamId).toBe("alpha");
		expect(registry.findByInstallationId(222)?.teamId).toBe("alpha");
	});

	it("findByInstallationId routes to the team that owns that installation, not any other", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-tenant-"));
		const registry = makeRegistry();

		const alpha = await registry.getOrCreate("alpha");
		const bravo = await registry.getOrCreate("bravo");
		alpha.accountState.current = accountStateWith(binding({ installationId: 111 }));
		bravo.accountState.current = accountStateWith(binding({ installationId: 222 }));

		expect(registry.findByInstallationId(111)?.teamId).toBe("alpha");
		expect(registry.findByInstallationId(222)?.teamId).toBe("bravo");
		expect(registry.findByInstallationId(999)).toBeUndefined();
	});

	it("hydrateExisting loads every team directory already on disk without a prior request", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-tenant-"));
		const { writeJsonFileAtomic } = await import("../../src/engine/jsonFile.js");
		await writeJsonFileAtomic(join(dir, "teams", "alpha", "installation.json"), accountStateWith(binding({ installationId: 333 })));
		await writeJsonFileAtomic(join(dir, "teams", "bravo", "installation.json"), accountStateWith(binding({ installationId: 444 })));

		const registry = makeRegistry();
		await registry.hydrateExisting();

		expect(registry.all().map((t) => t.teamId).sort()).toEqual(["alpha", "bravo"]);
		expect(registry.findByInstallationId(333)?.teamId).toBe("alpha");
		expect(registry.findByInstallationId(444)?.teamId).toBe("bravo");
	});

	it("rejects a team id that doesn't look like one this process minted before touching the filesystem", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-tenant-"));
		const registry = makeRegistry();

		await expect(registry.getOrCreate("../../etc/passwd")).rejects.toThrow();
	});

	describe("isInstallationBoundToOtherTeam", () => {
		it("is false when no team has the installation bound", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-tenant-"));
			const registry = makeRegistry();
			await registry.getOrCreate("alpha");

			expect(registry.isInstallationBoundToOtherTeam(555, "alpha")).toBe(false);
		});

		it("is false when the exempted team itself holds the installation", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-tenant-"));
			const registry = makeRegistry();
			const alpha = await registry.getOrCreate("alpha");
			alpha.accountState.current = binding({ installationId: 555 });

			expect(registry.isInstallationBoundToOtherTeam(555, "alpha")).toBe(false);
		});

		it("is true when a different team already holds the installation", async () => {
			dir = await mkdtemp(join(tmpdir(), "quire-tenant-"));
			const registry = makeRegistry();
			const alpha = await registry.getOrCreate("alpha");
			await registry.getOrCreate("bravo");
			alpha.accountState.current = binding({ installationId: 555 });

			expect(registry.isInstallationBoundToOtherTeam(555, "bravo")).toBe(true);
		});
	});
});
