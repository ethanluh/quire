import type { LlmCall, LlmCallOptions, LlmMessage, LlmProvider } from "./provider.js";

export class StubLlmProvider implements LlmProvider {
	private readonly completionQueue: string[] = [];
	private readonly embeddingMap: Map<string, ReadonlyArray<number>> = new Map();
	private readonly _calls: LlmCall[] = [];

	// Configurable (default "stub") so tests can construct two stubs with distinct
	// modelKeys to exercise cache-invalidation-on-provider-change behavior.
	constructor(readonly modelKey: string = "stub") {}

	readonly supportsEmbeddings = false;

	get calls(): ReadonlyArray<LlmCall> {
		return this._calls;
	}

	queueCompletion(response: string): void {
		this.completionQueue.push(response);
	}

	setEmbedding(text: string, vec: ReadonlyArray<number>): void {
		this.embeddingMap.set(text, vec);
	}

	async complete(messages: ReadonlyArray<LlmMessage>, _opts?: LlmCallOptions): Promise<string> {
		const next = this.completionQueue.shift();
		if (next === undefined) {
			// Default: return an empty effects list rather than throwing in dev mode
			return "[]";
		}
		this._calls.push({ messages, response: next });
		return next;
	}

	async embed(text: string): Promise<ReadonlyArray<number>> {
		return this.embeddingMap.get(text) ?? (Array(1536).fill(0) as number[]);
	}
}
