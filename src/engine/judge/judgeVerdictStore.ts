import type { JudgeVerdictRecord } from "../types/judge.js";
import { loadState, saveState } from "./verdictPersistence.js";

// Current verdict per bundle, keyed by (bundleId, inputsHash) — mirrors AuditStore/
// DecidedPrStore exactly: persist before mutating in-memory state, serialize every mutating
// call through one promise chain (so a webhook-triggered run and a reconcile-poll-triggered
// run for the same team never read-modify-write off a stale snapshot), atomic JSON writes via
// createJsonStatePersistence. A bundle re-judged after a new commit (new inputsHash) gets a
// new record that supersedes the old one for idempotency-check purposes — see save().
export class JudgeVerdictStore {
	private entries: ReadonlyArray<JudgeVerdictRecord> = [];
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

	// The idempotency check runJudgeForBundle (orchestrate.ts) uses before ever calling the
	// judge: an exact (bundleId, inputsHash) match means this bundle's current content has
	// already been judged, so re-ingesting it (a webhook retrigger, the reconcile poll) must
	// not re-run the judge or re-log a duplicate verdict.
	find(bundleId: string, inputsHash: string): JudgeVerdictRecord | undefined {
		return this.entries.find((e) => e.bundleId === bundleId && e.inputsHash === inputsHash);
	}

	async save(record: JudgeVerdictRecord): Promise<void> {
		await this.enqueue(async () => {
			// Replaces any prior record for this bundleId (even one with a different
			// inputsHash) — only the bundle's current content's verdict is ever looked up by
			// find(); a stale record from before the bundle's last commit would otherwise
			// accumulate forever with no consumer.
			const entries = [...this.entries.filter((e) => e.bundleId !== record.bundleId), record];
			if (this.statePath !== undefined) await saveState(this.statePath, { entries });
			this.entries = entries;
		});
	}

	list(): ReadonlyArray<JudgeVerdictRecord> {
		return this.entries;
	}
}

export async function loadJudgeVerdictStore(statePath?: string): Promise<JudgeVerdictStore> {
	const store = new JudgeVerdictStore(statePath);
	await store.load();
	return store;
}
