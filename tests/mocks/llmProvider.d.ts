import type { LlmCall, LlmCallOptions, LlmMessage, LlmProvider } from "../../src/engine/drift/effectList/provider.js";
export declare class StubLlmProvider implements LlmProvider {
    private readonly completionQueue;
    private readonly embeddingMap;
    private readonly _calls;
    get calls(): ReadonlyArray<LlmCall>;
    queueCompletion(response: string): void;
    setEmbedding(text: string, vec: ReadonlyArray<number>): void;
    complete(messages: ReadonlyArray<LlmMessage>, _opts?: LlmCallOptions): Promise<string>;
    embed(text: string): Promise<ReadonlyArray<number>>;
}
