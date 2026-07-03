export interface Allowlist {
	isAllowed(login: string): boolean;
}

// Empty/unset means "no allowlist configured" -> allow-all, matching this codebase's
// existing convention of features being off/permissive when their env var is unset (see
// the OAuth-optional pattern in routes/account.ts). Documented in .env.example as "you
// almost certainly want this set once hosted," not a silent trap.
export function createAllowlist(raw: string | undefined): Allowlist {
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
