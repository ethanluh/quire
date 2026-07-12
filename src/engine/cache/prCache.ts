import { createHash } from "node:crypto";
import { loadState, saveState } from "./prCachePersistence.js";

export interface CachedPrEffects {
	prId: string;
	headSha: string;
	repoOwner: string;
	repoName: string;
	// Identifies the LLM provider+model that produced `effects` (see LlmProvider.modelKey)
	// — a cache hit requires this to match too, not just (prId, headSha), so reconnecting
	// a different LLM account or shipping a new default model can't silently keep serving
	// effects extracted by the old one.
	modelKey: string;
	// extractEffects() output, cached verbatim — INV-2: never keyed or gated on declaredDirection.
	effects: ReadonlyArray<string>;
	cachedAt: string;
}

export interface CachedEmbedding {
	textHash: string;
	modelKey: string;
	vector: ReadonlyArray<number>;
	cachedAt: string;
}

export interface PrCacheState {
	effects: ReadonlyArray<CachedPrEffects>;
	embeddings: ReadonlyArray<CachedEmbedding>;
}

function hashText(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

// Persists effect-extraction results (keyed on PR id + head SHA + model) and embedding
// vectors (keyed on embedded-text hash + model) across pipeline runs, so a refresh that
// finds no new commits for a PR skips re-calling the LLM/embedding provider entirely.
// Disk-backed (see prCachePersistence.ts) rather than ServerState-only, since the refresh
// trigger fires on every page load across arbitrary server lifetimes.
export class PrEffectCache {
	private state: PrCacheState = { effects: [], embeddings: [] };
	private dirty = false;
	// Serializes save()'s actual disk writes so concurrent mutations (clusterPRs' 4-way
	// embedding-comparison concurrency, or two different repos' refreshes sharing this one
	// server-wide instance — enqueueRefresh only locks per-repo) can never race two
	// overlapping writeFile/rename pairs against the same on-disk file. Each save() chains
	// onto the previous write's completion instead of firing its own independent write.
	private writeChain: Promise<void> = Promise.resolve();

	// statePath omitted (e.g. a caller's default fresh instance) means this cache is
	// in-memory-only for its lifetime — every lookup misses on a brand-new instance,
	// which is exactly the "no caching" behavior callers fall back to when they don't
	// have a real persistent cache to pass in.
	constructor(private readonly statePath?: string) {}

	async load(): Promise<void> {
		if (this.statePath === undefined) return;
		this.state = await loadState(this.statePath);
	}

	// undefined covers "never cached", "headSha changed since cached", and "cached by a
	// different provider/model" — callers don't need to distinguish these, all three mean
	// "re-extract".
	getEffects(prId: string, headSha: string, modelKey: string): ReadonlyArray<string> | undefined {
		const entry = this.state.effects.find((e) => e.prId === prId);
		if (entry === undefined || entry.headSha !== headSha || entry.modelKey !== modelKey) return undefined;
		return entry.effects;
	}

	// In-memory only — does not persist. Callers that mutate many entries in one batch
	// (buildBundles' extraction loop) call save() once at the end instead of once per item.
	putEffects(
		prId: string,
		headSha: string,
		repoOwner: string,
		repoName: string,
		effects: ReadonlyArray<string>,
		modelKey: string,
	): void {
		const cachedAt = new Date().toISOString();
		const remaining = this.state.effects.filter((e) => e.prId !== prId);
		this.state = {
			...this.state,
			effects: [...remaining, { prId, headSha, repoOwner, repoName, effects, modelKey, cachedAt }],
		};
		this.dirty = true;
	}

	// Drops cached effects for PRs that no longer appear in `liveIds` (closed/merged),
	// scoped to one repo so switching between repos never cross-evicts another repo's cache.
	async evictStaleForRepo(owner: string, name: string, liveIds: ReadonlySet<string>): Promise<void> {
		const effects = this.state.effects.filter(
			(e) => !(e.repoOwner === owner && e.repoName === name) || liveIds.has(e.prId),
		);
		if (effects.length === this.state.effects.length) return;
		this.state = { ...this.state, effects };
		this.dirty = true;
		await this.save();
	}

	getEmbedding(text: string, modelKey: string): ReadonlyArray<number> | undefined {
		const textHash = hashText(text);
		return this.state.embeddings.find((e) => e.textHash === textHash && e.modelKey === modelKey)?.vector;
	}

	// In-memory only — see putEffects.
	putEmbedding(text: string, vector: ReadonlyArray<number>, modelKey: string): void {
		const textHash = hashText(text);
		const cachedAt = new Date().toISOString();
		const remaining = this.state.embeddings.filter(
			(e) => !(e.textHash === textHash && e.modelKey === modelKey),
		);
		this.state = { ...this.state, embeddings: [...remaining, { textHash, modelKey, vector, cachedAt }] };
		this.dirty = true;
	}

	// The single point where put*'s in-memory-only mutations actually hit disk. A no-op
	// if nothing changed since the last save (avoids a redundant write when two batches
	// happen to both call save() with nothing new in between).
	//
	// A failed write never throws and never poisons the chain. This cache is purely an
	// optimization — the in-memory state is still correct after a failed write, so a
	// transient disk error (ENOSPC, EIO) must not abort the refresh that called save(),
	// and — since this instance is shared server-wide across every repo's refreshes — it
	// must not leave writeChain permanently rejected, which would make every future
	// save() a no-op-that-throws until restart. The `.catch` before chaining mirrors
	// keyedLock.ts; `dirty` is re-set on failure so the next save() retries the write
	// instead of believing the failed snapshot was persisted.
	async save(): Promise<void> {
		if (this.statePath === undefined || !this.dirty) return;
		this.dirty = false;
		const path = this.statePath;
		const snapshot = this.state;
		const write = this.writeChain.catch(() => undefined).then(() => saveState(path, snapshot));
		this.writeChain = write;
		try {
			await write;
		} catch (err) {
			this.dirty = true;
			console.error(`pr-cache write failed (kept in memory, will retry on next save): ${path}:`, err);
		}
	}
}
