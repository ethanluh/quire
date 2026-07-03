import type { GestureAction } from "../types/core.js";
import type { DecidedPrState } from "../types/decided.js";
import { loadState, saveState } from "./decidedPrPersistence.js";

// Tracks PRs that already received a human gesture (accept/reject/defer). GitHub keeps
// reporting a PR as "open" until it's actually merged or closed — rejecting or deferring
// in Quire doesn't touch the underlying PR at all, and an accepted PR stays open until the
// merge queue lands it — so without this, a webhook or reconciliation-poll refresh would
// re-fetch and re-ingest the same already-decided PRs on every cycle.
export class DecidedPrStore {
	private state: DecidedPrState = { entries: [] };

	constructor(private readonly statePath: string) {}

	async load(): Promise<void> {
		this.state = await loadState(this.statePath);
	}

	async markDecided(
		prIds: ReadonlyArray<string>,
		action: GestureAction,
		context: { decidedBy: string; bundleId: string; wasAssignedTo?: string; overrodeAssignment?: boolean },
	): Promise<void> {
		const decidedAt = new Date().toISOString();
		const remaining = this.state.entries.filter((e) => !prIds.includes(e.prId));
		const added = prIds.map((prId) => ({ prId, action, decidedAt, ...context }));
		this.state = { entries: [...remaining, ...added] };
		await saveState(this.statePath, this.state);
	}

	isDecided(prId: string): boolean {
		return this.state.entries.some((e) => e.prId === prId);
	}

	async clearDecided(prId: string): Promise<void> {
		if (!this.state.entries.some((e) => e.prId === prId)) return;
		this.state = { entries: this.state.entries.filter((e) => e.prId !== prId) };
		await saveState(this.statePath, this.state);
	}

	async clearAll(): Promise<void> {
		this.state = { entries: [] };
		await saveState(this.statePath, this.state);
	}
}
