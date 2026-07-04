// Per-key promise chaining: serializes calls sharing a key against each other while letting
// different keys run concurrently. Each caller gets its own independent key namespace (one
// map per createKeyedLock() call), so unrelated call sites never collide on a shared key.
// Extracted from the identical lock previously duplicated in collaboratorSyncLog.ts and
// installationLock.ts. (teamStore.ts's withTeamLock is the same pattern but lives outside
// this module — left as-is; a repo-level decision.)
export function createKeyedLock(): <R>(key: string, fn: () => Promise<R>) => Promise<R> {
	const locks = new Map<string, Promise<unknown>>();
	return <R>(key: string, fn: () => Promise<R>): Promise<R> => {
		const previous = locks.get(key) ?? Promise.resolve();
		const run = previous.catch(() => undefined).then(fn);
		locks.set(key, run);
		run.finally(() => {
			if (locks.get(key) === run) locks.delete(key);
		}).catch(() => undefined);
		return run;
	};
}
