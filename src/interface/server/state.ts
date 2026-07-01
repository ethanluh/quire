import type { Bundle, ReviewCard } from "../../engine/types/core.js";

export interface ShelvedBundle {
	card: ReviewCard;
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
