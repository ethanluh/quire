import { readJsonFile, writeJsonFileAtomic } from "../jsonFile.js";

// Shared shape behind the per-domain JSON-state persistence modules (queue/persistence.ts,
// queue/decidedPrPersistence.ts): validate on read, fall back to an empty state when the file
// is absent or malformed, and write atomically. Each caller keeps its own named loadState/
// saveState export (implemented by destructuring this factory) so importers are untouched.
//
// `migrate` runs only on a successfully-validated state, letting a caller default fields that
// predate the current schema (e.g. queue entries written before mergedPrIds existed) without
// widening the type guard. Omit it when no migration is needed.
export function createJsonStatePersistence<T>(
	isValid: (value: unknown) => value is T,
	empty: T,
	migrate?: (state: T) => T,
): {
	loadState: (path: string) => Promise<T>;
	saveState: (path: string, state: T) => Promise<void>;
} {
	return {
		async loadState(path: string): Promise<T> {
			const state = await readJsonFile(path, isValid);
			if (state === undefined) return empty;
			return migrate !== undefined ? migrate(state) : state;
		},
		async saveState(path: string, state: T): Promise<void> {
			await writeJsonFileAtomic(path, state);
		},
	};
}
