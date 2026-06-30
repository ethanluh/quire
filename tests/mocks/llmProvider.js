export class StubLlmProvider {
    completionQueue = [];
    embeddingMap = new Map();
    _calls = [];
    get calls() {
        return this._calls;
    }
    queueCompletion(response) {
        this.completionQueue.push(response);
    }
    setEmbedding(text, vec) {
        this.embeddingMap.set(text, vec);
    }
    async complete(messages, _opts) {
        const next = this.completionQueue.shift();
        if (next === undefined)
            throw new Error("StubLlmProvider: no queued completion");
        this._calls.push({ messages, response: next });
        return next;
    }
    async embed(text) {
        return this.embeddingMap.get(text) ?? Array(1536).fill(0);
    }
}
