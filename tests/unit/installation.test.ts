import { describe, it, expect, afterEach } from "@jest/globals";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadInstallation, saveInstallation, clearInstallation } from "../../src/engine/github/installation.js";
import type { InstallationBinding } from "../../src/engine/github/installation.js";

describe("github installation persistence", () => {
	let dir: string;

	afterEach(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	it("returns undefined when no installation file exists", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-installation-"));
		const binding = await loadInstallation(join(dir, "installation.json"));
		expect(binding).toBeUndefined();
	});

	it("round-trips a saved binding, creating parent dirs as needed", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-installation-"));
		const path = join(dir, "nested", "installation.json");
		const binding: InstallationBinding = {
			installationId: 42,
			accountLogin: "octocat",
			accountType: "Organization",
			boundAt: "2026-06-30T00:00:00.000Z",
		};

		await saveInstallation(path, binding);
		const loaded = await loadInstallation(path);

		expect(loaded).toEqual(binding);
	});

	it("treats a corrupted file as not connected", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-installation-"));
		const path = join(dir, "installation.json");
		await saveInstallation(path, { installationId: 1, accountLogin: "x", accountType: "User", boundAt: "now" });
		await rm(path);
		const { writeFile } = await import("node:fs/promises");
		await writeFile(path, "not json", "utf8");

		const loaded = await loadInstallation(path);

		expect(loaded).toBeUndefined();
	});

	it("clearInstallation removes the file without throwing if it never existed", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-installation-"));
		const path = join(dir, "installation.json");
		await saveInstallation(path, { installationId: 1, accountLogin: "octocat", accountType: "User", boundAt: "now" });

		await clearInstallation(path);
		await expect(clearInstallation(path)).resolves.toBeUndefined();
		expect(await loadInstallation(path)).toBeUndefined();
	});
});
