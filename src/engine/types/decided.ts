import type { GestureAction } from "./core.js";

export interface DecidedPrEntry {
	prId: string;
	action: GestureAction;
	decidedAt: string;
	decidedBy: string;
	// The bundle is deleted from state.bundles/cards on decision, so this is the only way an
	// audit view can later group "these N decided PRs were one bundle decision."
	bundleId: string;
	wasAssignedTo?: string;
	// True only when the owner/admin force-override path was used to gesture on a bundle
	// assigned to someone else — the one genuinely dangerous case worth flagging after the fact.
	overrodeAssignment?: boolean;
}

export interface DecidedPrState {
	entries: ReadonlyArray<DecidedPrEntry>;
}
