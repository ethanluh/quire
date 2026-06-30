import type { Bundle } from "../types/core.js";

export function computeBlastRadius(bundle: Bundle): number {
	const allFiles = new Set<string>();
	for (const member of bundle.members) {
		for (const f of member.filesTouched) {
			allFiles.add(f);
		}
	}
	return allFiles.size;
}
