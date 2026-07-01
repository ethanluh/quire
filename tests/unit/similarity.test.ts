import { describe, it, expect } from "@jest/globals";
import { clusterPRs, textSimilarity } from "../../src/engine/bundle/similarity.js";
import type { PullRequest } from "../../src/engine/types/core.js";
import type { EmbeddingProvider } from "../../src/engine/drift/effectList/provider.js";

function makePR(id: string): PullRequest {
	return {
		id, repoOwner: "org", repoName: "repo", number: 1,
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
