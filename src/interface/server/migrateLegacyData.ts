import { existsSync } from "node:fs";
import { mkdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type { TeamStore } from "../../engine/team/teamStore.js";

const LEGACY_FILES = ["installation.json", "queue.json", "decided-prs.json", "pr-cache.json", "llm-account.json"];
const LEGACY_INSTRUMENTATION_FILES = ["defers.ndjson", "gate-decisions.ndjson", "drift-screen.ndjson", "audit.ndjson"];

// Move (never copy) each named file that exists from one dir to another, sequentially —
// a crash mid-migration can't leave a half-copied duplicate on disk.
async function moveExisting(files: ReadonlyArray<string>, fromDir: string, toDir: string): Promise<void> {
	for (const file of files) {
		const from = join(fromDir, file);
		if (existsSync(from)) await rename(from, join(toDir, file));
	}
}

// data/github-account.json is a leftover from the pre-GitHub-App PAT login model (see
// README/CLAUDE.md) — nothing still reads it for auth, but it's the one file that ever
// recorded whose account this data belongs to, so it's the best source for attributing
// legacy data to a login during migration.
async function resolveLegacyLogin(dataDir: string, allowedLogins: string | undefined): Promise<string | undefined> {
	const githubAccountPath = join(dataDir, "github-account.json");
	if (existsSync(githubAccountPath)) {
		try {
			const raw: unknown = JSON.parse(await readFile(githubAccountPath, "utf8"));
			const login = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>)["login"] : undefined;
			if (typeof login === "string" && login.length > 0) return login;
		} catch {
			// corrupted file — fall through to the allowlist guess below
		}
	}
	const logins = (allowedLogins ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	return logins.length === 1 ? logins[0] : undefined;
}

// Runs once at startup, before registry.hydrateExisting() (see index.ts) — a no-op both
// on a fresh install (no legacy files) and on every boot after the first successful
// migration (data/teams/ already existing is the idempotency guard either way). Moves
// (never copies) the old flat data/*.json layout into data/teams/<teamId>/, so a crash
// mid-migration can't leave a half-copied duplicate on disk.
export async function migrateLegacyData(dataDir: string, teamStore: TeamStore, allowedLogins: string | undefined): Promise<void> {
	if (existsSync(join(dataDir, "teams"))) return;

	const hasLegacyData = LEGACY_FILES.some((file) => existsSync(join(dataDir, file)));
	if (!hasLegacyData) return;

	const login = await resolveLegacyLogin(dataDir, allowedLogins);
	if (login === undefined) {
		console.warn(
			"Found pre-team data/*.json but couldn't tell whose account it belongs to " +
				"(no data/github-account.json, and QUIRE_ALLOWED_GITHUB_LOGINS isn't exactly one login) — " +
				"leaving it in place. Signing in will get a fresh personal team; move the old files into " +
				"data/teams/<teamId>/ by hand under the same filenames if you want to keep them.",
		);
		return;
	}

	const team = await teamStore.createTeamForLogin(login, `${login}'s team`);
	const teamDir = join(dataDir, "teams", team.teamId);

	await moveExisting(LEGACY_FILES, dataDir, teamDir);

	const legacyInstrumentationDir = join(dataDir, "instrumentation");
	if (LEGACY_INSTRUMENTATION_FILES.some((file) => existsSync(join(legacyInstrumentationDir, file)))) {
		await mkdir(join(teamDir, "instrumentation"), { recursive: true });
		await moveExisting(LEGACY_INSTRUMENTATION_FILES, legacyInstrumentationDir, join(teamDir, "instrumentation"));
	}

	console.log(`Migrated pre-team data for ${login} into data/teams/${team.teamId}/`);
}
