const RETRYABLE_STATUSES = new Set([429, 503]);
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 200;

// Preserves the HTTP status as data (not just flattened into the message text)
// so a future caller can tell a transient rate-limit apart from a fatal
// credentials/request error without parsing the message string.
export class LlmApiError extends Error {
	constructor(
		public readonly provider: string,
		public readonly status: number,
		bodyText: string,
	) {
		super(`${provider} API error ${status}: ${bodyText}`);
		this.name = "LlmApiError";
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// Retries only 429 (rate-limited) and 503 (overloaded) with linear backoff —
// every other non-2xx status is fatal on the first attempt, since retrying a
// bad request or bad credentials just wastes time and quota.
export async function fetchWithRetry(provider: string, url: string, init: RequestInit): Promise<Response> {
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		const res = await fetch(url, init);
		if (res.ok) return res;
		if (!RETRYABLE_STATUSES.has(res.status) || attempt === MAX_ATTEMPTS) {
			throw new LlmApiError(provider, res.status, await res.text());
		}
		await delay(BASE_DELAY_MS * attempt);
	}
	throw new Error("unreachable");
}
