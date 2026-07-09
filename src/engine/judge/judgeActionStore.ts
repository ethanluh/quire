import type { JudgeActionRecord } from "../types/judge.js";
import { loadState, saveState } from "./actionPersistence.js";

// Idempotency and re-entrancy guard for the judge's autonomous action pipeline — mirrors
// JudgeVerdictStore exactly (persist-before-mutate, one promise chain serializing every
// mutating call, atomic JSON writes). The one (bundleId, inputsHash) pair this store's find()
// matches on is the single choke point that stops a replayed webhook, a re-entrant reconcile
// poll, or a concurrent check_suite delivery from ever attempting a second merge or a second
// revert for the same bundle content.
export class JudgeActionStore {
	private entries: ReadonlyArray<JudgeActionRecord> = [];
	private queue: Promise<unknown> = Promise.resolve();

	constructor(private readonly statePath?: string) {}

	private enqueue<T>(fn: () => Promise<T>): Promise<T> {
		const result = this.queue.then(fn, fn);
		this.queue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	async load(): Promise<void> {
		if (this.statePath === undefined) return;
		this.entries = (await loadState(this.statePath)).entries;
	}

	find(bundleId: string, inputsHash: string): JudgeActionRecord | undefined {
		return this.entries.find((e) => e.bundleId === bundleId && e.inputsHash === inputsHash);
	}

	// Every entry whose status is "awaitingVerification" — read by the check_suite webhook
	// handler and the timeout sweep to find which pending member SHAs a given delivery (or
	// elapsed deadline) might resolve.
	listAwaitingVerification(): ReadonlyArray<JudgeActionRecord> {
		return this.entries.filter((e) => e.status === "awaitingVerification");
	}

	async save(record: JudgeActionRecord): Promise<void> {
		await this.enqueue(async () => {
			const entries = [...this.entries.filter((e) => e.bundleId !== record.bundleId), record];
			if (this.statePath !== undefined) await saveState(this.statePath, { entries });
			this.entries = entries;
		});
	}

	list(): ReadonlyArray<JudgeActionRecord> {
		return this.entries;
	}
}

export async function loadJudgeActionStore(statePath?: string): Promise<JudgeActionStore> {
	const store = new JudgeActionStore(statePath);
	await store.load();
	return store;
}
