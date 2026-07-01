// Runs fn over items with at most `limit` in flight at once, settling every item
// independently (like Promise.allSettled) instead of failing the whole batch when
// one item rejects. Used where a real network-backed call replaced what used to be
// a free in-memory lookup: unlimited fan-out risks a rate-limit thundering herd,
// but the fully-sequential alternative wastes the concurrency a real provider can
// absorb.
export async function settleWithConcurrency<T, R>(
	items: ReadonlyArray<T>,
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<ReadonlyArray<PromiseSettledResult<R>>> {
	const results: PromiseSettledResult<R>[] = new Array(items.length);
	let nextIndex = 0;

	async function worker(): Promise<void> {
		for (;;) {
			const i = nextIndex++;
			if (i >= items.length) return;
			try {
				results[i] = { status: "fulfilled", value: await fn(items[i] as T, i) };
			} catch (err) {
				results[i] = { status: "rejected", reason: err };
			}
		}
	}

	const workerCount = Math.max(1, Math.min(limit, items.length));
	await Promise.all(Array.from({ length: workerCount }, () => worker()));
	return results;
}
