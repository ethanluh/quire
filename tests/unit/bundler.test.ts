import { describe, it, expect } from "@jest/globals";
import { buildBundles } from "../../src/engine/bundle/bundler.js";
import { StubLlmProvider } from "../mocks/llmProvider.js";
import { PrEffectCache } from "../../src/engine/cache/prCache.js";
import type { Bundle, PullRequest } from "../../src/engine/types/core.js";
import type { LlmCall, LlmCallOptions, LlmMessage, LlmProvider } from "../../src/engine/drift/effectList/provider.js";
import { LlmApiError } from "../../src/engine/drift/effectList/httpRetry.js";

class FlakyProvider implements LlmProvider {
	private readonly inner = new StubLlmProvider();

	get calls(): ReadonlyArray<LlmCall> {
		return this.inner.calls;
	}

	get modelKey(): string {
		return this.inner.modelKey;
	}

	queueCompletion(response: string): void {
		this.inner.queueCompletion(response);
	}

	async complete(messages: ReadonlyArray<LlmMessage>, opts?: LlmCallOptions): Promise<string> {
		if (messages.some((m) => m.content.includes("FAIL_EXTRACTION_MARKER"))) {
			// Real providers throw LlmApiError, not a plain Error — drive the real shape
			// through buildBundles() so its error handling is actually exercised.
			throw new LlmApiError("Test", 503, "provider timeout");
		}
		return this.inner.complete(messages, opts);
	}

	async embed(text: string): Promise<ReadonlyArray<number>> {
		return this.inner.embed(text);
	}
}

function makePR(id: string, direction: string, overrides: Partial<PullRequest> = {}): PullRequest {
	return {
		id, repoOwner: "org", repoName: "repo", number: 1,
		headSha: `sha-${id}`,
		declaredDirection: direction,
		diff: { raw: "", hunks: [] },
		filesTouched: [`src/${id}.ts`],
		symbolsTouched: [], testNamesChanged: [], ciStatus: "success",
		...overrides,
	};
}

describe("buildBundles — clusters on drift-check evidence, not declaredDirection (INV-1)", () => {
	it("does not bundle PRs with the same declaredDirection but divergent extracted effects", async () => {
		const stub = new StubLlmProvider();
		// Extraction is blind to declaredDirection — both PRs declare the same direction,
		// but what they actually do (per extraction) has nothing in common.
		stub.queueCompletion(JSON.stringify(["adds OTP-based login flow"]));
		stub.queueCompletion(JSON.stringify(["migrates database connection pooling to a new ORM"]));

		const prs = [
			makePR("pr-a", "add passwordless auth"),
			makePR("pr-b", "add passwordless auth"),
		];

		const { bundles } = await buildBundles(prs, stub, { similarityThreshold: 0.75 });

		expect(bundles.length).toBe(2);
		const memberIds = bundles.map((b) => b.members.map((m) => m.id));
		expect(memberIds).not.toContainEqual(["pr-a", "pr-b"]);
	});

	it("bundles PRs with differing declaredDirection text when extracted effects agree", async () => {
		const stub = new StubLlmProvider();
		stub.queueCompletion(JSON.stringify(["adds OTP-based login flow to the auth endpoint"]));
		stub.queueCompletion(JSON.stringify(["adds OTP-based login flow to the auth endpoint"]));

		const prs = [
			makePR("pr-a", "add passwordless auth"),
			makePR("pr-b", "improve sign-in security"),
		];

		const { bundles } = await buildBundles(prs, stub, { similarityThreshold: 0.75 });

		expect(bundles.length).toBe(1);
		expect(bundles[0]?.members.map((m) => m.id)).toEqual(["pr-a", "pr-b"]);
	});

	it("returns the effects it extracted so callers can reuse them for the drift check", async () => {
		const stub = new StubLlmProvider();
		stub.queueCompletion(JSON.stringify(["adds OTP-based login flow"]));

		const prs = [makePR("pr-a", "add passwordless auth")];
		const { effectsByPr } = await buildBundles(prs, stub, { similarityThreshold: 0.75 });

		expect(effectsByPr.get("pr-a")).toEqual(["adds OTP-based login flow"]);
	});

	it("sets bundle.effectSummary from extracted effects, not from declaredDirection", async () => {
		const stub = new StubLlmProvider();
		stub.queueCompletion(JSON.stringify(["adds OTP-based login flow"]));

		const prs = [makePR("pr-a", "add passwordless auth")];
		const { bundles } = await buildBundles(prs, stub, { similarityThreshold: 0.75 });

		expect(bundles[0]?.direction).toBe("add passwordless auth");
		expect(bundles[0]?.effectSummary).toBe("adds OTP-based login flow");
	});

	it("excludes a PR whose effect extraction failed, without discarding bundling for the rest", async () => {
		const provider = new FlakyProvider();
		provider.queueCompletion(JSON.stringify(["adds OTP-based login flow"])); // pr-good's extraction

		const prs = [
			makePR("pr-bad", "add passwordless auth", { diff: { raw: "FAIL_EXTRACTION_MARKER", hunks: [] } }),
			makePR("pr-good", "add passwordless auth"),
		];

		const { bundles, extractionFailures } = await buildBundles(prs, provider, { similarityThreshold: 0.75 });

		expect(extractionFailures.map((f) => f.pr.id)).toEqual(["pr-bad"]);
		expect(bundles.length).toBe(1);
		expect(bundles[0]?.members.map((m) => m.id)).toEqual(["pr-good"]);
	});
});

describe("buildBundles — effect-extraction cache", () => {
	it("skips extractEffects entirely on a cache hit (same PR id + headSha as a prior run)", async () => {
		const cache = new PrEffectCache();
		const stub = new StubLlmProvider();
		stub.queueCompletion(JSON.stringify(["adds OTP-based login flow"])); // extractor
		stub.queueCompletion(JSON.stringify([{ clause: "adds OTP-based login flow", matchedDirection: true }])); // unused here, just headroom

		const pr = makePR("pr-a", "add passwordless auth");
		const first = await buildBundles([pr], stub, { similarityThreshold: 0.75 }, cache);
		expect(first.reextractedPrIds.has("pr-a")).toBe(true);
		expect(stub.calls).toHaveLength(1);

		// Second run: same id + headSha, same cache instance — must not call complete() again.
		const second = await buildBundles([pr], stub, { similarityThreshold: 0.75 }, cache);
		expect(stub.calls).toHaveLength(1);
		expect(second.reextractedPrIds.size).toBe(0);
		expect(second.effectsByPr.get("pr-a")).toEqual(["adds OTP-based login flow"]);
		expect(second.bundles[0]?.members.map((m) => m.id)).toEqual(["pr-a"]);
	});

	it("re-extracts a PR whose headSha changed since it was cached", async () => {
		const cache = new PrEffectCache();
		const stub = new StubLlmProvider();
		stub.queueCompletion(JSON.stringify(["adds OTP-based login flow"]));
		stub.queueCompletion(JSON.stringify(["adds passkey support"]));

		const pr = makePR("pr-a", "add passwordless auth");
		await buildBundles([pr], stub, { similarityThreshold: 0.75 }, cache);
		expect(stub.calls).toHaveLength(1);

		const updatedPr = { ...pr, headSha: "sha-pr-a-v2" };
		const second = await buildBundles([updatedPr], stub, { similarityThreshold: 0.75 }, cache);
		expect(stub.calls).toHaveLength(2);
		expect(second.reextractedPrIds.has("pr-a")).toBe(true);
		expect(second.effectsByPr.get("pr-a")).toEqual(["adds passkey support"]);
	});
});

describe("buildBundles — seeded clustering from a prior run's bundles", () => {
	it("carries an unchanged bundle forward without re-extracting or re-clustering its member", async () => {
		const cache = new PrEffectCache();
		const stub = new StubLlmProvider();
		stub.queueCompletion(JSON.stringify(["adds OTP-based login flow"]));

		const prA = makePR("pr-a", "add passwordless auth");
		const first = await buildBundles([prA], stub, { similarityThreshold: 0.75 }, cache);
		expect(first.bundles).toHaveLength(1);
		const priorBundle = first.bundles[0]!;

		// Second run: pr-a unchanged, seeded from the prior run's bundle. No new LLM calls
		// (extraction skipped via cache) and no embed() calls needed for pr-a's comparison
		// since it's carried over via the seed rather than re-clustered.
		const second = await buildBundles([prA], stub, { similarityThreshold: 0.75 }, cache, [priorBundle]);
		expect(stub.calls).toHaveLength(1);
		expect(second.bundles).toHaveLength(1);
		expect(second.bundles[0]?.id).toBe(priorBundle.id);
		expect(second.bundles[0]?.members.map((m) => m.id)).toEqual(["pr-a"]);
	});

	it("does not seed a bundle whose member is missing from the current PR set (closed/merged)", async () => {
		const cache = new PrEffectCache();
		const stub = new StubLlmProvider();
		stub.queueCompletion(JSON.stringify(["adds OTP-based login flow"]));
		stub.queueCompletion(JSON.stringify(["adds OTP-based login flow"]));

		const prA = makePR("pr-a", "add passwordless auth");
		const prB = makePR("pr-b", "add passwordless auth");
		const first = await buildBundles([prA, prB], stub, { similarityThreshold: 0.75 }, cache);
		const priorBundle = first.bundles[0]!;
		expect(priorBundle.members.map((m) => m.id).sort()).toEqual(["pr-a", "pr-b"]);

		// pr-b is gone this run (e.g. merged) — the seed must not be trusted as-is, and
		// pr-a (still present, unchanged) must still end up clustered on its own.
		const second: { bundles: ReadonlyArray<Bundle> } = await buildBundles(
			[prA], stub, { similarityThreshold: 0.75 }, cache, [priorBundle],
		);
		expect(stub.calls).toHaveLength(2); // no new extraction; still just the two from setup
		expect(second.bundles).toHaveLength(1);
		expect(second.bundles[0]?.members.map((m) => m.id)).toEqual(["pr-a"]);
	});

	it("refreshes a seeded member's declaredDirection/ciStatus even though its effects came from cache", async () => {
		const cache = new PrEffectCache();
		const stub = new StubLlmProvider();
		stub.queueCompletion(JSON.stringify(["adds OTP-based login flow"]));

		const prA = makePR("pr-a", "add passwordless auth");
		const first = await buildBundles([prA], stub, { similarityThreshold: 0.75 }, cache);
		const priorBundle = first.bundles[0]!;

		// pr-a's PR body was edited on GitHub (declaredDirection changed, ciStatus flipped)
		// with no new commit — headSha unchanged, so this is still a cache hit for effects.
		const prAEdited = { ...prA, declaredDirection: "refactor auth token storage", ciStatus: "failure" as const };
		const second = await buildBundles([prAEdited], stub, { similarityThreshold: 0.75 }, cache, [priorBundle]);

		expect(stub.calls).toHaveLength(1); // still no re-extraction
		expect(second.bundles[0]?.direction).toBe("refactor auth token storage");
		expect(second.bundles[0]?.members[0]?.declaredDirection).toBe("refactor auth token storage");
		expect(second.bundles[0]?.members[0]?.ciStatus).toBe("failure");
	});
});
