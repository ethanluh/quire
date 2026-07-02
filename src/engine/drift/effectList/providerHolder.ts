import type { LlmCall, LlmCallOptions, LlmMessage, LlmProvider } from "./provider.js";

// PipelineDeps is constructed once at startup holding a reference to an LlmProvider.
// Connecting/disconnecting an LLM account through the UI needs to change which provider
// that reference resolves to without restarting the process, so the holder is the
// indirection point: it implements LlmProvider itself and forwards every call to
// whichever provider is current at call time. Mirrors GitHubClientHolder.
export class LlmProviderHolder implements LlmProvider {
	private current: LlmProvider;

	constructor(initial: LlmProvider) {
		this.current = initial;
	}

	setProvider(provider: LlmProvider): void {
		this.current = provider;
	}

	get calls(): ReadonlyArray<LlmCall> {
		return this.current.calls;
	}

	complete(messages: ReadonlyArray<LlmMessage>, opts?: LlmCallOptions): Promise<string> {
		return this.current.complete(messages, opts);
	}

	embed(text: string): Promise<ReadonlyArray<number>> {
		return this.current.embed(text);
	}
}
