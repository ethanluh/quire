export interface Allowlist {
	isAllowed(login: string): boolean;
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
export function createAllowlist(raw: string | undefined): Allowlist {
	if (raw !== undefined && raw.trim() === "*") {
		return { isAllowed: () => true };
	}

	const logins = new Set(
		(raw ?? "")
			.split(",")
			.map((s) => s.trim().toLowerCase())
			.filter((s) => s.length > 0),
	);
	return {
		isAllowed: (login) => logins.size === 0 || logins.has(login.toLowerCase()),
	};
}
