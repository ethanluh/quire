import type { Bundle } from "../types/core.js";

const PUBLIC_API_RE = /(?:^|\/)(api|public|sdk|v\d+)\//i;
const MIGRATION_RE = /(?:migrations?|schema|\.sql)$/i;
const SHARED_MODULE_RE = /(?:^|\/)(shared|common|core|lib|utils?)\//i;

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

	return flags;
}
