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

// Linear backoff plus jitter, so concurrent callers retrying at once (see
// settleWithConcurrency call sites) don't all collide on the same schedule and
// re-trigger the same rate limit together.
function delay(attempt: number): Promise<void> {
	const ms = BASE_DELAY_MS * attempt + Math.random() * BASE_DELAY_MS;
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// Retries 429 (rate-limited), 503 (overloaded), and network-level failures
// (fetch() itself rejecting — DNS, connection reset, TLS, timeout — before any
// response exists) with linear backoff. Every other non-2xx status is fatal on
// the first attempt, since retrying a bad request or bad credentials just
// wastes time and quota.
export async function fetchWithRetry(provider: string, url: string, init: RequestInit): Promise<Response> {
	let lastNetworkError: unknown;
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		let res: Response;
		try {
			res = await fetch(url, init);
		} catch (err) {
			lastNetworkError = err;
			if (attempt === MAX_ATTEMPTS) throw err;
			await delay(attempt);
			continue;
		}
		if (res.ok) return res;
		if (!RETRYABLE_STATUSES.has(res.status) || attempt === MAX_ATTEMPTS) {
			throw new LlmApiError(provider, res.status, await res.text());
		}
		await delay(attempt);
	}
	throw lastNetworkError ?? new Error("unreachable");
}
