import { describe, it, expect, afterEach } from "@jest/globals";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadInstallation, saveInstallation, clearInstallation } from "../../src/engine/github/installation.js";
import type { InstallationAccountState, InstallationBinding, RepoBinding } from "../../src/engine/github/installation.js";

const BINDING_A: InstallationBinding = {
	installationId: 42,
	accountLogin: "octocat",
	accountType: "Organization",
	boundAt: "2026-06-30T00:00:00.000Z",
};

const BINDING_B: InstallationBinding = {
	installationId: 43,
	accountLogin: "acme-corp",
	accountType: "Organization",
	boundAt: "2026-06-30T00:00:00.000Z",
};

describe("github installation persistence", () => {
	let dir: string;

	afterEach(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	it("returns undefined when no installation file exists", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-installation-"));
		const state = await loadInstallation(join(dir, "installation.json"));
		expect(state).toBeUndefined();
	});

	it("round-trips a saved single-installation state, creating parent dirs as needed", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-installation-"));
		const path = join(dir, "nested", "installation.json");
		const state: InstallationAccountState = { installations: [BINDING_A], repos: [] };

		await saveInstallation(path, state);
		const loaded = await loadInstallation(path);

		expect(loaded).toEqual(state);
	});

	it("round-trips multiple bound installations plus multiple watched repos with per-repo settings", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-installation-"));
		const path = join(dir, "installation.json");
		const repoA: RepoBinding = {
			owner: "acme-corp",
			name: "widgets",
			installationId: 43,
			autoMergeOnAccept: true,
			addedAt: "2026-06-30T00:00:00.000Z",
			addedBy: "alice",
		};
		const repoB: RepoBinding = {
			owner: "octocat",
			name: "gadgets",
			installationId: 42,
			flagConflictsForFleet: true,
			addedAt: "2026-06-30T00:00:00.000Z",
			addedBy: "bob",
		};
		const state: InstallationAccountState = {
			installations: [BINDING_A, BINDING_B],
			repos: [repoA, repoB],
		};

		await saveInstallation(path, state);
		const loaded = await loadInstallation(path);

		expect(loaded).toEqual(state);
	});

	it("treats a corrupted file as not connected", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-installation-"));
		const path = join(dir, "installation.json");
		await saveInstallation(path, { installations: [BINDING_A], repos: [] });
		await rm(path);
		await writeFile(path, "not json", "utf8");

		const loaded = await loadInstallation(path);

		expect(loaded).toBeUndefined();
	});

	it("treats the old pre-multi-installation single-binding shape as not connected (no migration path)", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-installation-"));
		const path = join(dir, "installation.json");
		await writeFile(path, JSON.stringify(BINDING_A), "utf8");

		const loaded = await loadInstallation(path);

		expect(loaded).toBeUndefined();
	});

	it("treats the pre-multi-repo shape (selectedRepo/autoMergeOnAccept at the top level) as not connected (no migration path)", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-installation-"));
		const path = join(dir, "installation.json");
		await writeFile(
			path,
			JSON.stringify({ installations: [BINDING_A], selectedRepo: { owner: "octocat", name: "widgets", installationId: 42 } }),
			"utf8",
		);

		const loaded = await loadInstallation(path);

		expect(loaded).toBeUndefined();
	});

	it("clearInstallation removes the file without throwing if it never existed", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-installation-"));
		const path = join(dir, "installation.json");
		await saveInstallation(path, { installations: [BINDING_A], repos: [] });

		await clearInstallation(path);
		await expect(clearInstallation(path)).resolves.toBeUndefined();
		expect(await loadInstallation(path)).toBeUndefined();
	});
});
