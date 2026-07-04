import type { Bundle } from "../types/core.js";

export function computeBlastRadius(bundle: Bundle): number {
	return new Set(bundle.members.flatMap((m) => m.filesTouched)).size;
}
