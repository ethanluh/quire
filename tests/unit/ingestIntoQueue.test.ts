import { describe, it, expect } from "@jest/globals";
import { ingestIntoQueue } from "../../src/interface/server/ingestIntoQueue.js";
import type { PipelineDeps } from "../../src/interface/server/ingestIntoQueue.js";
import { createServerState } from "../../src/interface/server/state.js";
import { LlmProviderHolder } from "../../src/engine/drift/effectList/providerHolder.js";
import { StubStaticAnalyzer } from "../mocks/staticAnalyzer.js";
import { AuditStore } from "../../src/engine/gate/auditStore.js";
import { PrEffectCache } from "../../src/engine/cache/prCache.js";
import type { PipelineConfig } from "../../src/engine/pipeline/pipeline.js";
import type { PullRequest } from "../../src/engine/types/core.js";
import type { LlmCall, LlmMessage, LlmProvider } from "../../src/engine/drift/effectList/provider.js";

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

function taggedProvider(tag: string): LlmProvider {
	const calls: LlmCall[] = [];
	return {
		modelKey: `stub:${tag}`,
		get calls(): ReadonlyArray<LlmCall> {
			return calls;
		},
		async complete(messages: ReadonlyArray<LlmMessage>) {
			const response = JSON.stringify([`${tag}-effect`]);
			calls.push({ messages, response });
			return response;
		},
		async embed() {
			return [];
		},
	};
}

const PIPELINE_CONFIG: PipelineConfig = {
	gate: { criteria: [] },
	bundle: { similarityThreshold: 0.75 },
};

describe("ingestIntoQueue — pins the LLM provider for the duration of one ingestion run", () => {
	it("keeps using the provider that was active when the run started, even if the holder is reassigned before the run finishes", async () => {
		const prA = makePR("pr-a");
		const providerA = taggedProvider("A");
		const providerB = taggedProvider("B");
		const holder = new LlmProviderHolder(providerA);

		const deps: PipelineDeps = {
			config: PIPELINE_CONFIG,
			provider: holder,
			analyzer: new StubStaticAnalyzer(),
			auditStore: new AuditStore(),
			prCache: new PrEffectCache(),
		};

		// ingestIntoQueue snapshots the holder's current provider synchronously before its
		// first await, so reassigning the holder right after invoking it (but before
		// awaiting) proves the run already captured providerA and cannot be affected by a
		// later swap — the same guarantee that protects a run against a connect/disconnect
		// that happens once real extraction/clustering work is underway.
		const resultPromise = ingestIntoQueue([prA], createServerState(), deps);
		holder.setProvider(providerB);
		await resultPromise;

		expect(providerB.calls).toHaveLength(0);
		expect(providerA.calls.length).toBeGreaterThan(0);
	});

	it("passes a plain (non-holder) LlmProvider straight through unchanged", async () => {
		const prA = makePR("pr-a");
		const provider = taggedProvider("plain");

		const deps: PipelineDeps = {
			config: PIPELINE_CONFIG,
			provider,
			analyzer: new StubStaticAnalyzer(),
			auditStore: new AuditStore(),
			prCache: new PrEffectCache(),
		};

		await ingestIntoQueue([prA], createServerState(), deps);

		expect(provider.calls.length).toBeGreaterThan(0);
	});
});
