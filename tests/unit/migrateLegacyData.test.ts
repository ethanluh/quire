import { describe, it, expect, afterEach, jest } from "@jest/globals";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateLegacyData } from "../../src/interface/server/migrateLegacyData.js";
import { TeamStore } from "../../src/engine/team/teamStore.js";
import { writeJsonFileAtomic } from "../../src/engine/jsonFile.js";

describe("migrateLegacyData", () => {
	let dir: string;

	afterEach(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	it("does nothing on a fresh install with no legacy files", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-migrate-"));
		const store = new TeamStore(dir);

		await migrateLegacyData(dir, store, undefined);

		expect(existsSync(join(dir, "teams"))).toBe(false);
	});

	it("is a no-op once data/teams/ already exists, even if legacy files are still present", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-migrate-"));
		await writeJsonFileAtomic(join(dir, "installation.json"), { installationId: 1 });
		await mkdir(join(dir, "teams", "existing-team"), { recursive: true });
		const store = new TeamStore(dir);

		await migrateLegacyData(dir, store, undefined);

		// The legacy file is left exactly where it was — migration never ran.
		expect(existsSync(join(dir, "installation.json"))).toBe(true);
	});

	it("attributes legacy data to the login in data/github-account.json and moves the files under it", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-migrate-"));
		await writeJsonFileAtomic(join(dir, "installation.json"), { installationId: 42, accountLogin: "octocat", accountType: "User" });
		await writeJsonFileAtomic(join(dir, "queue.json"), { entries: [] });
		await writeFile(join(dir, "github-account.json"), JSON.stringify({ login: "alice", token: "gho_secret" }), "utf8");
		const store = new TeamStore(dir);

		await migrateLegacyData(dir, store, undefined);

		const index = await store.loadMembershipIndex("alice");
		expect(index).toBeDefined();
		const teamId = index?.activeTeamId as string;
		const team = await store.loadTeam(teamId);
		expect(team?.createdBy).toBe("alice");

		expect(existsSync(join(dir, "installation.json"))).toBe(false);
		expect(existsSync(join(dir, "queue.json"))).toBe(false);
		expect(existsSync(join(dir, "teams", teamId, "installation.json"))).toBe(true);
		expect(existsSync(join(dir, "teams", teamId, "queue.json"))).toBe(true);
	});

	it("moves instrumentation log files alongside the rest", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-migrate-"));
		await writeJsonFileAtomic(join(dir, "installation.json"), { installationId: 1 });
		await mkdir(join(dir, "instrumentation"), { recursive: true });
		await writeFile(join(dir, "instrumentation", "defers.ndjson"), "{}\n", "utf8");
		await writeFile(join(dir, "github-account.json"), JSON.stringify({ login: "alice" }), "utf8");
		const store = new TeamStore(dir);

		await migrateLegacyData(dir, store, undefined);

		const index = await store.loadMembershipIndex("alice");
		const teamId = index?.activeTeamId as string;
		expect(existsSync(join(dir, "instrumentation", "defers.ndjson"))).toBe(false);
		expect(existsSync(join(dir, "teams", teamId, "instrumentation", "defers.ndjson"))).toBe(true);
	});

	it("falls back to a single-entry QUIRE_ALLOWED_GITHUB_LOGINS when github-account.json is absent", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-migrate-"));
		await writeJsonFileAtomic(join(dir, "installation.json"), { installationId: 1 });
		const store = new TeamStore(dir);

		await migrateLegacyData(dir, store, "bob");

		expect(await store.loadMembershipIndex("bob")).toBeDefined();
	});

	it("leaves legacy files in place and warns when the owning login can't be determined", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-migrate-"));
		await writeJsonFileAtomic(join(dir, "installation.json"), { installationId: 1 });
		const store = new TeamStore(dir);
		const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);

		await migrateLegacyData(dir, store, "alice,bob");

		expect(existsSync(join(dir, "teams"))).toBe(false);
		expect(existsSync(join(dir, "installation.json"))).toBe(true);
		expect(warnSpy).toHaveBeenCalled();
		warnSpy.mockRestore();
	});

	it("treats a corrupted github-account.json as absent and falls back to the allowlist", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-migrate-"));
		await writeJsonFileAtomic(join(dir, "installation.json"), { installationId: 1 });
		await writeFile(join(dir, "github-account.json"), "not json", "utf8");
		const store = new TeamStore(dir);

		await migrateLegacyData(dir, store, "carol");

		expect(await store.loadMembershipIndex("carol")).toBeDefined();
	});
});
