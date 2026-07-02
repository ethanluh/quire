import { describe, it, expect } from "@jest/globals";
import { clusterPRs, textSimilarity } from "../../src/engine/bundle/similarity.js";
import type { PullRequest } from "../../src/engine/types/core.js";
import type { EmbeddingProvider } from "../../src/engine/drift/effectList/provider.js";

function makePR(id: string): PullRequest {
	return {
		id, repoOwner: "org", repoName: "repo", number: 1,
		headSha: `sha-${id}`,
		declaredDirection: "add passwordless auth",
		diff: { raw: "", hunks: [] },
		filesTouched: [`src/${id}.ts`],
		symbolsTouched: [], testNamesChanged: [], ciStatus: "success",
	};
}

class FailingOnceProvider implements EmbeddingProvider {
	private readonly failOn: Set<string>;
	calls: string[] = [];

	constructor(failOn: ReadonlyArray<string>) {
		this.failOn = new Set(failOn);
	}

	async embed(text: string): Promise<ReadonlyArray<number>> {
		this.calls.push(text);
		if (this.failOn.has(text)) {
			this.failOn.delete(text); // fails only the first time this exact text is embedded
			throw new Error("transient embedding outage");
		}
		return [text.length, 1];
	}
}

describe("textSimilarity — propagates a real embed() failure instead of masking it as Jaccard", () => {
	it("throws when embed() throws, rather than silently falling back", async () => {
		const provider: EmbeddingProvider = {
			embed: async () => {
				throw new Error("outage");
			},
		};
		await expect(textSimilarity("a", "b", provider)).rejects.toThrow("outage");
	});
});

describe("textSimilarity — empty inputs must not read as perfect similarity", () => {
	it("returns 0, not 1, for two empty strings via the Jaccard fallback", async () => {
		const zeroVectorProvider: EmbeddingProvider = {
			embed: async () => [0, 0],
		};
		await expect(textSimilarity("", "", zeroVectorProvider)).resolves.toBe(0);
	});

	it("returns 0 even when a real (non-zero-vector) provider returns an identical embedding for empty input", async () => {
		// A real embedding-capable provider (e.g. a connected Gemini account) is
		// deterministic: embed("") always returns the same real, non-zero vector, since
		// it's a stateless call keyed only on model + input text. Two PRs with no
		// extracted effects must not read as identical just because their shared "no
		// evidence" text happens to embed the same way — this must be caught before any
		// embed() call is made, not left to depend on a particular provider's behavior.
		const realEmbeddingProvider: EmbeddingProvider = {
			embed: async () => [0.42, 0.17, 0.9],
		};
		await expect(textSimilarity("", "", realEmbeddingProvider)).resolves.toBe(0);
	});

	it("returns 0 for whitespace-only input compared against another whitespace-only input", async () => {
		const realEmbeddingProvider: EmbeddingProvider = {
			embed: async () => [0.42, 0.17, 0.9],
		};
		await expect(textSimilarity("   ", "\t", realEmbeddingProvider)).resolves.toBe(0);
	});
});

describe("clusterPRs — PRs with no extracted effects must not spuriously merge", () => {
	it("puts each PR with an empty effect list into its own singleton cluster", async () => {
		const prA = makePR("pr-a");
		const prB = makePR("pr-b");
		const prC = makePR("pr-c");

		const effectsByPr = new Map([
			["pr-a", []],
			["pr-b", []],
			["pr-c", []],
		]);

		const zeroVectorProvider: EmbeddingProvider = {
			embed: async () => [0, 0],
		};
		const { clusters, failures } = await clusterPRs(
			[prA, prB, prC],
			effectsByPr,
			zeroVectorProvider,
			{ threshold: 0.75 },
		);

		expect(failures).toEqual([]);
		expect(clusters).toHaveLength(3);
		for (const cluster of clusters) {
			expect(cluster).toHaveLength(1);
		}
	});
});

describe("clusterPRs — a real embedding provider must not merge PRs that share no extracted effects", () => {
	it("keeps PRs with empty effect lists in their own singleton clusters even against a provider that returns identical non-zero vectors for any input", async () => {
		const prA = makePR("pr-a");
		const prB = makePR("pr-b");

		const effectsByPr = new Map([
			["pr-a", []],
			["pr-b", []],
		]);

		// Simulates a live Gemini connection: embed() hits a real API and returns the same
		// deterministic, non-zero vector for any input, including "".
		const realEmbeddingProvider: EmbeddingProvider = {
			embed: async () => [0.42, 0.17, 0.9],
		};
		const { clusters, failures } = await clusterPRs(
			[prA, prB],
			effectsByPr,
			realEmbeddingProvider,
			{ threshold: 0.75 },
		);

		expect(failures).toEqual([]);
		expect(clusters).toHaveLength(2);
		for (const cluster of clusters) {
			expect(cluster).toHaveLength(1);
		}
	});
});

describe("clusterPRs — isolates a clustering failure to the affected PR (mirrors extractionFailures)", () => {
	it("excludes a PR whose comparison failed, without discarding clusters already built for the rest", async () => {
		const prA = makePR("pr-a");
		const prB = makePR("pr-b"); // will fail comparing against pr-a's centroid
		const prC = makePR("pr-c");

		const effectsByPr = new Map([
			["pr-a", ["adds OTP login"]],
			["pr-b", ["adds OTP login"]],
			["pr-c", ["migrates database connection pooling"]],
		]);

		const provider = new FailingOnceProvider(["adds OTP login"]);
		const { clusters, failures } = await clusterPRs(
			[prA, prB, prC],
			effectsByPr,
			provider,
			{ threshold: 0.75 },
		);

		// pr-a seeds a centroid (no prior centroids to compare against, so it can't fail).
		// pr-b's comparison against pr-a's centroid fails and pr-b is excluded this round.
		// pr-c still gets clustered normally afterward.
		expect(failures.map((f) => f.pr.id)).toEqual(["pr-b"]);
		const clusteredIds = clusters.flat().map((pr) => pr.id);
		expect(clusteredIds).toContain("pr-a");
		expect(clusteredIds).toContain("pr-c");
		expect(clusteredIds).not.toContain("pr-b");
	});

	it("does not permanently poison the cache: a later PR can still succeed against the same centroid text", async () => {
		const prA = makePR("pr-a");
		const prB = makePR("pr-b"); // fails against pr-a's centroid
		const prC = makePR("pr-c"); // compares against the same centroid text — must not reuse the stale rejection

		const effectsByPr = new Map([
			["pr-a", ["adds OTP login"]],
			["pr-b", ["adds OTP login"]],
			["pr-c", ["adds OTP login"]],
		]);

		const provider = new FailingOnceProvider(["adds OTP login"]);
		const { clusters, failures } = await clusterPRs(
			[prA, prB, prC],
			effectsByPr,
			provider,
			{ threshold: 0.75 },
		);

		expect(failures.map((f) => f.pr.id)).toEqual(["pr-b"]);
		// pr-c has identical effect text to pr-a's centroid and should join it once the
		// (evicted) cache entry is retried fresh, instead of reusing pr-b's stale rejection.
		const clusteredIds = clusters.flat().map((pr) => pr.id);
		expect(clusteredIds).toContain("pr-c");
	});
});

describe("clusterPRs — seeded clustering produces the same grouping as a full unseeded pass", () => {
	it("carries a pre-existing cluster forward as a seed and joins a new PR to it exactly as an unseeded pass would", async () => {
		const prA = makePR("pr-a"); // seed anchor from a "prior run"
		const prB = makePR("pr-b"); // new PR this run, similar enough to join pr-a's cluster
		const prC = makePR("pr-c"); // new PR this run, unrelated — starts its own cluster

		const effectsByPr = new Map([
			["pr-a", ["adds OTP login"]],
			["pr-b", ["adds OTP login"]],
			["pr-c", ["migrates database connection pooling"]],
		]);
		const provider: EmbeddingProvider = {
			embed: async (text) => (text.includes("OTP") ? [1, 0] : [0, 1]),
		};

		const seeded = await clusterPRs(
			[prB, prC],
			effectsByPr,
			provider,
			{ threshold: 0.75 },
			[{ centroidText: "adds OTP login", members: [prA] }],
		);
		const unseeded = await clusterPRs(
			[prA, prB, prC],
			effectsByPr,
			provider,
			{ threshold: 0.75 },
		);

		const normalize = (result: typeof seeded) =>
			result.clusters.map((c) => c.map((pr) => pr.id).sort()).sort();
		expect(normalize(seeded)).toEqual(normalize(unseeded));
		expect(seeded.failures).toEqual([]);
	});

	it("never re-embeds a seed's centroid text when every comparison for it is served from the embedding cache", async () => {
		const prB = makePR("pr-b");
		const calls: string[] = [];
		const provider: EmbeddingProvider = {
			embed: async (text) => {
				calls.push(text);
				return text.includes("OTP") ? [1, 0] : [0, 1];
			},
		};
		const embeddingCache = new Map<string, ReadonlyArray<number>>([["adds OTP login", [1, 0]]]);
		const cache = {
			getEmbedding: (text: string) => embeddingCache.get(text),
			putEmbedding: (text: string, vector: ReadonlyArray<number>) => {
				embeddingCache.set(text, vector);
			},
		};

		await clusterPRs(
			[prB],
			new Map([["pr-b", ["adds OTP login"]]]),
			provider,
			{ threshold: 0.75 },
			[{ centroidText: "adds OTP login", members: [] }],
			cache,
			"stub",
		);

		// pr-b's own text and the seed centroid text are identical here, so a cache hit on
		// the centroid means embed() is never called for either side of the comparison.
		expect(calls).toEqual([]);
	});
});
