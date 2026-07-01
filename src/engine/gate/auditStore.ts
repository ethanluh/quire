import type { PullRequest } from "../types/core.js";
import { appendNdjson, readNdjson } from "../instrumentation/store.js";

export interface AuditEntry {
	pr: PullRequest;
	criterionName: string;
	reason: string;
	addedAt: string;
}

// Persistence is best-effort and fire-and-forget: `add` is called synchronously from
// inside `runGate`'s per-criterion loop, and making that loop async to await a write
// would ripple through the whole gate/pipeline call chain for no real benefit — losing
// a single audit write on process crash is an acceptable trade next to that refactor.
export class AuditStore {
	private readonly entries: AuditEntry[] = [];
	private pendingWrite: Promise<void> = Promise.resolve();

	constructor(private readonly logPath?: string) {}

	static async load(logPath: string): Promise<AuditStore> {
		const store = new AuditStore(logPath);
		const persisted = await readNdjson<AuditEntry>(logPath);
		store.entries.push(...persisted);
		return store;
	}

	add(pr: PullRequest, criterionName: string, reason: string): void {
		const entry: AuditEntry = { pr, criterionName, reason, addedAt: new Date().toISOString() };
		this.entries.push(entry);
		if (this.logPath !== undefined) {
			const logPath = this.logPath;
			// Chained (not fired in parallel) so concurrent `add` calls don't interleave
			// partial lines when appending to the same file.
			this.pendingWrite = this.pendingWrite.then(() =>
				appendNdjson(logPath, entry).catch((err: unknown) => {
					console.error("Failed to persist audit entry:", err);
				}),
			);
		}
	}

	// Resolves once every write kicked off by `add` so far has settled. Callers that
	// don't care about persistence timing (the gate's normal request path) never need
	// this; it exists for restart-durability tests and any future "flush before reload".
	async flush(): Promise<void> {
		await this.pendingWrite;
	}

	list(): ReadonlyArray<AuditEntry> {
		return this.entries;
	}

	clear(): void {
		this.entries.length = 0;
	}
}
