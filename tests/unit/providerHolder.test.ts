import { describe, it, expect } from "@jest/globals";
import { LlmProviderHolder } from "../../src/engine/drift/effectList/providerHolder.js";
import type { LlmCall, LlmMessage, LlmProvider } from "../../src/engine/drift/effectList/provider.js";

function makeProvider(name: string): LlmProvider {
	const calls: LlmCall[] = [];
	return {
		modelKey: `stub:${name}`,
		get calls() {
			return calls;
		},
		async complete(messages: ReadonlyArray<LlmMessage>) {
			const response = `${name}: ${messages.length} messages`;
			calls.push({ messages, response });
			return response;
		},
		async embed() {
			return [name.length];
		},
	};
}

describe("LlmProviderHolder", () => {
	it("forwards complete()/embed()/calls to the initial provider", async () => {
		const holder = new LlmProviderHolder(makeProvider("first"));
		const response = await holder.complete([{ role: "user", content: "hi" }]);
		expect(response).toBe("first: 1 messages");
		expect(await holder.embed("x")).toEqual([5]);
		expect(holder.calls).toHaveLength(1);
	});

	it("setProvider() swaps which provider answers subsequent calls without a restart", async () => {
		const holder = new LlmProviderHolder(makeProvider("first"));
		await holder.complete([{ role: "user", content: "hi" }]);

		holder.setProvider(makeProvider("second"));
		const response = await holder.complete([{ role: "user", content: "hi" }]);

		expect(response).toBe("second: 1 messages");
		// calls now reflects only the second provider's history, not a merge of both.
		expect(holder.calls).toHaveLength(1);
	});

	it("snapshot() returns a plain reference unaffected by a later setProvider() call", async () => {
		const holder = new LlmProviderHolder(makeProvider("first"));
		const snapshot = holder.snapshot();

		holder.setProvider(makeProvider("second"));
		const response = await snapshot.complete([{ role: "user", content: "hi" }]);

		expect(response).toBe("first: 1 messages");
	});
});
