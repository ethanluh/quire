import { createHash } from "node:crypto";
import { loadState, saveState } from "./prCachePersistence.js";

export interface CachedPrEffects {
	prId: string;
	headSha: string;
	repoOwner: string;
	repoName: string;
	// extractEffects() output, cached verbatim — INV-2: never keyed or gated on declaredDirection.
	effects: ReadonlyArray<string>;
	cachedAt: string;
}

export interface CachedEmbedding {
	textHash: string;
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

// Persists effect-extraction results (keyed on PR id + head SHA) and embedding vectors
// (keyed on embedded-text hash) across pipeline runs, so a refresh that finds no new
// commits for a PR skips re-calling the LLM/embedding provider entirely. Disk-backed
// (see prCachePersistence.ts) rather than ServerState-only, since the refresh trigger
// fires on every page load across arbitrary server lifetimes.
export class PrEffectCache {
	private state: PrCacheState = { effects: [], embeddings: [] };

	// statePath omitted (e.g. a caller's default fresh instance) means this cache is
	// in-memory-only for its lifetime — every lookup misses on a brand-new instance,
	// which is exactly the "no caching" behavior callers fall back to when they don't
	// have a real persistent cache to pass in.
	constructor(private readonly statePath?: string) {}

	async load(): Promise<void> {
		if (this.statePath === undefined) return;
		this.state = await loadState(this.statePath);
	}

	private async persist(): Promise<void> {
		if (this.statePath === undefined) return;
		await saveState(this.statePath, this.state);
	}

	// undefined covers both "never cached" and "headSha changed since cached" — callers
	// don't need to distinguish the two, both mean "re-extract".
	getEffects(prId: string, headSha: string): ReadonlyArray<string> | undefined {
		const entry = this.state.effects.find((e) => e.prId === prId);
		if (entry === undefined || entry.headSha !== headSha) return undefined;
		return entry.effects;
	}

	async putEffects(
		prId: string,
		headSha: string,
		repoOwner: string,
		repoName: string,
		effects: ReadonlyArray<string>,
	): Promise<void> {
		const cachedAt = new Date().toISOString();
		const remaining = this.state.effects.filter((e) => e.prId !== prId);
		this.state = {
			...this.state,
			effects: [...remaining, { prId, headSha, repoOwner, repoName, effects, cachedAt }],
		};
		await this.persist();
	}

	// Drops cached effects for PRs that no longer appear in `liveIds` (closed/merged),
	// scoped to one repo so switching between repos never cross-evicts another repo's cache.
	async evictStaleForRepo(owner: string, name: string, liveIds: ReadonlySet<string>): Promise<void> {
		const effects = this.state.effects.filter(
			(e) => !(e.repoOwner === owner && e.repoName === name) || liveIds.has(e.prId),
		);
		if (effects.length === this.state.effects.length) return;
		this.state = { ...this.state, effects };
		await this.persist();
	}

	getEmbedding(text: string): ReadonlyArray<number> | undefined {
		return this.state.embeddings.find((e) => e.textHash === hashText(text))?.vector;
	}

	async putEmbedding(text: string, vector: ReadonlyArray<number>): Promise<void> {
		const textHash = hashText(text);
		const cachedAt = new Date().toISOString();
		const remaining = this.state.embeddings.filter((e) => e.textHash !== textHash);
		this.state = { ...this.state, embeddings: [...remaining, { textHash, vector, cachedAt }] };
		await this.persist();
	}
}
