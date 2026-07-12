import { join } from "node:path";
import { readJsonFile, writeJsonFileAtomic } from "../../engine/jsonFile.js";
import { sanitizeIdentifier } from "../../engine/util/identifier.js";

// Sessions are stateless signed cookies (see session.ts) — there's no server-side session table
// to delete a row from on logout, so without this a signed token stays cryptographically valid
// until its expiry no matter how many times the user "logs out." This store records, per login,
// an instant before which every issued session is invalid; /logout bumps it to now, and
// requireSession rejects any token whose issuedAt predates it. Result: logout actually
// terminates the session (and lets an operator boot a login with a leaked cookie), while keeping
// the stateless, no-session-table design.
//
// Backed by a tiny per-login JSON file under the same data/users/<login>/ root as the login's
// membership index and refresh token. Cached in memory so the hot path (no logout ever recorded
// for this login) is a Map lookup, not a disk read per request; the disk copy exists only so a
// server restart can't resurrect a cookie that was invalidated before it went down.
interface StoredSessionEpoch {
	invalidatedBefore: number;
}

function isStoredSessionEpoch(value: unknown): value is StoredSessionEpoch {
	return typeof value === "object" && value !== null && typeof (value as Record<string, unknown>)["invalidatedBefore"] === "number";
}

export interface SessionEpochStore {
	// Sessions for this login issued at or after the returned instant (ms) are valid; anything
	// earlier has been invalidated (logout). 0 means "nothing ever invalidated for this login."
	invalidatedBefore(login: string): Promise<number>;
	// Records that every session issued up to `at` is now invalid. Called on logout.
	invalidateSessions(login: string, at: number): Promise<void>;
}

export function createSessionEpochStore(dataDir: string): SessionEpochStore {
	// login -> invalidatedBefore. Absent key means "not yet loaded from disk"; a loaded login
	// with no file is cached as 0 so we don't re-hit the disk on every request.
	const cache = new Map<string, number>();

	function pathFor(login: string): string {
		return join(dataDir, "users", sanitizeIdentifier(login, { scope: "user data", label: "login" }), "session-epoch.json");
	}

	return {
		async invalidatedBefore(login) {
			const cached = cache.get(login);
			if (cached !== undefined) return cached;
			const stored = await readJsonFile(pathFor(login), isStoredSessionEpoch);
			const value = stored?.invalidatedBefore ?? 0;
			cache.set(login, value);
			return value;
		},
		async invalidateSessions(login, at) {
			// Monotonic: never move the marker backwards, so a stale/racing logout can't
			// re-validate sessions a later logout already killed.
			const current = cache.get(login) ?? (await readJsonFile(pathFor(login), isStoredSessionEpoch))?.invalidatedBefore ?? 0;
			const next = Math.max(current, at);
			cache.set(login, next);
			await writeJsonFileAtomic(pathFor(login), { invalidatedBefore: next });
		},
	};
}
