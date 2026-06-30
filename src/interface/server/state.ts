import type { Bundle, ReviewCard } from "../../engine/types/core.js";

export interface ServerState {
	bundles: Map<string, Bundle>;
	cards: Map<string, ReviewCard>;
	shelf: Map<string, ReviewCard>;
}

export function createServerState(): ServerState {
	return {
		bundles: new Map(),
		cards: new Map(),
		shelf: new Map(),
	};
}
