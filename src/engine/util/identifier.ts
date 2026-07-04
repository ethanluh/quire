// Validates that an externally-supplied identifier is safe to join straight into a
// filesystem path — GitHub logins and this process's own minted team ids are both restricted
// to alphanumeric characters and hyphens, so anything outside that set is refused rather than
// trusted blindly. `kind` is the full "scope <what> to unexpected <what>" phrasing the throw
// message uses, so each call site keeps its own verbatim message (a login vs a team id).
// Consolidated from teamStore.ts's sanitizeLogin and tenant.ts's sanitizeTeamId — see the
// conciseness review's TS-2 finding.
const VALID_IDENTIFIER = /^[A-Za-z0-9-]+$/;

export interface IdentifierKind {
	// e.g. "team data" (teamStore) or "tenant data" (tenant) — the noun the id scopes.
	scope: string;
	// e.g. "login" or "team id" — what kind of identifier `value` is.
	label: string;
}

export function sanitizeIdentifier(value: string, kind: IdentifierKind): string {
	if (!VALID_IDENTIFIER.test(value)) {
		throw new Error(`Refusing to scope ${kind.scope} to unexpected ${kind.label}: ${JSON.stringify(value)}`);
	}
	return value;
}
