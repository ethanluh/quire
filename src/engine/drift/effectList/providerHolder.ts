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

	// Returns whatever provider is current right now, as a plain (non-holder) reference.
	// A caller running a multi-step operation that compares results against each other
	// (e.g. one ingestion run clustering many PRs) should snapshot once up front rather
	// than reading through the holder on every call, so a connect/disconnect that happens
	// mid-run can't split that one run across two different providers/models.
	snapshot(): LlmProvider {
		return this.current;
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
