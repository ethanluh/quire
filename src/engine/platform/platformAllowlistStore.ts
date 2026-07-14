import { readJsonFile, writeJsonFileAtomic } from "../jsonFile.js";

function isStringList(value: unknown): value is ReadonlyArray<string> {
	return Array.isArray(value) && value.every((v) => typeof v === "string");
}

// A persisted, editable supplement to QUIRE_PLATFORM_ADMIN_LOGINS — logins added here are
// OR'd with the env-var list (see index.ts's combinedPlatformAdminAllowlist), never a
// replacement for it. The env var stays the non-UI-removable floor (see
// createPlatformAdminAllowlist's fail-closed default) so this store being emptied, or its
// file corrupted/deleted, can never widen or fully revoke platform-admin access on its own.
export class PlatformAllowlistStore {
	private logins: ReadonlyArray<string> = [];

	constructor(private readonly statePath: string) {}

	async load(): Promise<void> {
		this.logins = (await readJsonFile(this.statePath, isStringList)) ?? [];
	}

	get(): ReadonlyArray<string> {
		return this.logins;
	}

	async set(logins: ReadonlyArray<string>): Promise<void> {
		const normalized = [...new Set(logins.map((l) => l.trim().toLowerCase()).filter((l) => l.length > 0))];
		await writeJsonFileAtomic(this.statePath, normalized);
		this.logins = normalized;
	}
}
