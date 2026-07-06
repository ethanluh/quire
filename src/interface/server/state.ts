import type { Bundle, ReviewCard } from "../../engine/types/core.js";
import { loadState, saveState } from "../../engine/queue/shelfPersistence.js";

export interface ShelvedBundle {
	card: ReviewCard;
	// Optional only so existing lightweight test fixtures stay valid; every real defer
	// (gestures.ts) always sets it. Kept alongside `state.bundles` rather than relying on
	// it, since clearRepoFromQueue sweeps state.bundles per-repo independent of shelf status.
	bundle?: Bundle;
	// Kept alongside the card (not just on `Bundle`, which is dropped from state on defer)
	// so promoting a bundle back to review can clear its members' decided-PR record.
	memberPrIds: ReadonlyArray<string>;
}

export interface ServerState {
	bundles: Map<string, Bundle>;
	cards: Map<string, ReviewCard>;
	shelf: Map<string, ShelvedBundle>;
}

export function createServerState(): ServerState {
	return {
		bundles: new Map(),
		cards: new Map(),
		shelf: new Map(),
	};
}

// Restores the shelf across a process restart — state.shelf is otherwise purely in-memory,
// so a deferred bundle would silently vanish (neither in the review queue nor on the shelf)
// the moment the tenant reloads, even though its members stay correctly marked "decided" in
// decided-prs.json. Mutates `shelf` in place so it can run alongside decidedStore.load()/
// prCache.load() in loadTenant's startup Promise.all.
export async function hydrateShelf(shelf: Map<string, ShelvedBundle>, path: string): Promise<void> {
	const { entries } = await loadState(path);
	for (const { bundleId, ...rest } of entries) shelf.set(bundleId, rest);
}

export async function saveShelf(shelf: ReadonlyMap<string, ShelvedBundle>, path: string): Promise<void> {
	await saveState(path, { entries: [...shelf.entries()].map(([bundleId, shelved]) => ({ bundleId, ...shelved })) });
}
