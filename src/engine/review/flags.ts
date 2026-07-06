import type { Bundle } from "../types/core.js";

const PUBLIC_API_RE = /(?:^|\/)(api|public|sdk|v\d+)\//i;
const MIGRATION_RE = /(?:migrations?|schema|\.sql)$/i;
const SHARED_MODULE_RE = /(?:^|\/)(shared|common|core|lib|utils?)\//i;
// Segment-bounded so e.g. "author.ts" or "sessionize.ts" don't false-positive on "auth"/"session".
const AUTH_RE = /(?:^|\/)(auth|authn|authz|session|login|oauth|credentials?|permissions?)(?:[-_./]|$)/i;
const INFRA_RE = /(?:^|\/)(infra|infrastructure|deploy(?:ment)?|terraform|k8s|docker|\.github\/workflows)(?:\/|$)/i;

// Flags that gate the fast accept path (see requiresAcceptConfirmation in review/card.ts) —
// distinct from the other flags below, which are informational only.
export const HIGH_RISK_FLAGS: ReadonlyArray<string> = ["touches auth", "touches shared infra", "spans multiple repos"];

export function isHighRisk(flags: ReadonlyArray<string>): boolean {
	return flags.some((f) => HIGH_RISK_FLAGS.includes(f));
}

export function detectFlags(bundle: Bundle): ReadonlyArray<string> {
	const flags: string[] = [];
	const allFiles = bundle.members.flatMap((m) => [...m.filesTouched]);

	if (allFiles.some((f) => PUBLIC_API_RE.test(f))) {
		flags.push("touches public API");
	}
	if (allFiles.some((f) => MIGRATION_RE.test(f))) {
		flags.push("contains migration");
	}
	if (allFiles.some((f) => SHARED_MODULE_RE.test(f))) {
		flags.push("modifies shared module");
	}
	if (allFiles.some((f) => AUTH_RE.test(f))) {
		flags.push("touches auth");
	}
	if (allFiles.some((f) => INFRA_RE.test(f))) {
		flags.push("touches shared infra");
	}
	if (new Set(bundle.members.map((m) => `${m.repoOwner}/${m.repoName}`)).size > 1) {
		flags.push("spans multiple repos");
	}

	return flags;
}
