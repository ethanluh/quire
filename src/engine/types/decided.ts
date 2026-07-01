import type { GestureAction } from "./core.js";

export interface DecidedPrEntry {
	prId: string;
	action: GestureAction;
	decidedAt: string;
}

export interface DecidedPrState {
	entries: ReadonlyArray<DecidedPrEntry>;
}
