import type { Bundle, ReviewCard } from "./core.js";

export interface ShelfEntry {
	bundleId: string;
	card: ReviewCard;
	bundle?: Bundle;
	memberPrIds: ReadonlyArray<string>;
}

export interface ShelfState {
	entries: ReadonlyArray<ShelfEntry>;
}
