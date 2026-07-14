export interface Allowlist {
	isAllowed(login: string): boolean;
	// True when the allowlist admits every login — because it was configured empty
	// (unset/blank/only separators like "," or " ") OR via the explicit "*". index.ts's
	// production boot guard keys off THIS (the parsed result), not raw string-emptiness, so a
	// value like "," that looks configured but parses to nothing can't silently reopen the door.
	readonly allowsAll: boolean;
	// Distinguishes the intentional "*" allow-all (permitted even in production) from an
	// effectively-empty value (rejected in production). Only meaningful when allowsAll is true.
	readonly explicitWildcard: boolean;
}

// Empty/unset means "no allowlist configured" -> allow-all, matching this codebase's
// existing convention of features being off/permissive when their env var is unset (see
// the OAuth-optional pattern in routes/account.ts). Documented in .env.example as "you
// almost certainly want this set once hosted," not a silent trap.
//
// `*` is a second, explicit way to reach the same allow-all result. It exists because
// index.ts now throws at boot in production when this var is unset/empty (closing the
// silent-open-door footgun) — a host that genuinely wants to stay open to any GitHub
// account needs a non-empty value that still means "allow all" to satisfy that check.
// The base createAllowlist's "unset/empty -> allow all" convention is right for
// QUIRE_ALLOWED_GITHUB_LOGINS (a feature you opt into restricting) but wrong for a
// cross-tenant superadmin gate: an unconfigured platform-admin list must fail CLOSED
// (no one is a platform admin) rather than open (everyone signed in is). Only the
// explicit "*" wildcard is honored as an intentional allow-all here, same as the base
// allowlist — everything else that would otherwise resolve to allow-all resolves to
// deny-all instead.
export function createPlatformAdminAllowlist(raw: string | undefined): Allowlist {
	const parsed = createAllowlist(raw);
	if (parsed.allowsAll && !parsed.explicitWildcard) {
		return { isAllowed: () => false, allowsAll: false, explicitWildcard: false };
	}
	return parsed;
}

export function createAllowlist(raw: string | undefined): Allowlist {
	if (raw !== undefined && raw.trim() === "*") {
		return { isAllowed: () => true, allowsAll: true, explicitWildcard: true };
	}

	const logins = new Set(
		(raw ?? "")
			.split(",")
			.map((s) => s.trim().toLowerCase())
			.filter((s) => s.length > 0),
	);
	const allowsAll = logins.size === 0;
	return {
		isAllowed: (login) => allowsAll || logins.has(login.toLowerCase()),
		allowsAll,
		explicitWildcard: false,
	};
}
