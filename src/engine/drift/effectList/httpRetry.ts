// 500 (generic "INTERNAL" fault) is included alongside 429/503: it's Google's
// catch-all for a transient server-side hiccup, not a bad-request/credentials
// problem, so it's worth the same retry treatment rather than failing on the
// first attempt.
const RETRYABLE_STATUSES = new Set([429, 500, 503]);
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 200;
const DEFAULT_TIMEOUT_MS = 30_000;
// Above this, a server-suggested retry delay isn't worth sleeping through inside
// a single call (see fetchWithRetry) — it's treated as "fail fast" instead.
const SHORT_RETRY_THRESHOLD_MS = 3_000;

// Preserves the HTTP status as data (not just flattened into the message text)
// so a future caller can tell a transient rate-limit apart from a fatal
// credentials/request error without parsing the message string.
export class LlmApiError extends Error {
	constructor(
		public readonly provider: string,
		public readonly status: number,
		bodyText: string,
		// Server-suggested wait (parsed from a google.rpc.RetryInfo detail, if present),
		// so a caller can tell the user something concrete ("try again in 23s") instead
		// of re-parsing the raw body.
		public readonly retryAfterMs?: number,
		quotaExceeded = false,
	) {
		super(
			quotaExceeded
				? `${provider} quota exceeded — check billing/quota for this API key's project. ${provider} API error ${status}: ${bodyText}`
				: `${provider} API error ${status}: ${bodyText}`,
		);
		this.name = "LlmApiError";
	}
}

interface ParsedRetryInfo {
	retryAfterMs?: number;
	quotaExceeded: boolean;
}

// Google APIs (Gemini included) return structured detail objects alongside the
// human-readable message: a RetryInfo detail with a server-suggested wait, and a
// RESOURCE_EXHAUSTED status specifically for quota/billing exhaustion (as opposed
// to a generic transient rate limit). Parsing is defensive on purpose — a body
// that isn't this shape (a different provider, a proxy error page, ...) just
// yields no info and the caller falls back to today's blind linear backoff.
function parseRetryInfo(bodyText: string): ParsedRetryInfo {
	try {
		const parsed = JSON.parse(bodyText) as {
			error?: { status?: string; details?: ReadonlyArray<{ "@type"?: string; retryDelay?: string }> };
		};
		const quotaExceeded = parsed.error?.status === "RESOURCE_EXHAUSTED";
		const retryInfo = parsed.error?.details?.find((d) => d["@type"]?.endsWith("RetryInfo"));
		const match = retryInfo?.retryDelay?.match(/^(\d+(?:\.\d+)?)s$/);
		return match ? { retryAfterMs: Number(match[1]) * 1000, quotaExceeded } : { quotaExceeded };
	} catch {
		return { quotaExceeded: false };
	}
}

// Linear backoff plus jitter, so concurrent callers retrying at once (see
// settleWithConcurrency call sites) don't all collide on the same schedule and
// re-trigger the same rate limit together. A caller-supplied overrideMs (a short
// server-suggested retryDelay) takes precedence over the linear schedule.
function delay(attempt: number, overrideMs?: number): Promise<void> {
	const ms = overrideMs ?? BASE_DELAY_MS * attempt + Math.random() * BASE_DELAY_MS;
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// Retries 429 (rate-limited), 500 (internal server error), 503 (overloaded), and
// network-level failures (fetch() itself rejecting — DNS, connection reset, TLS,
// timeout — before any response exists) with linear backoff. Every other non-2xx
// status is fatal on the first attempt, since retrying a bad request or bad
// credentials just wastes time and quota.
//
// A retryable body is inspected for a server-suggested retryDelay: a short one
// (≤ SHORT_RETRY_THRESHOLD_MS) replaces the linear backoff for the next attempt,
// since it's a real hint about a genuine short burst. A long one (Gemini's
// RESOURCE_EXHAUSTED/zero-quota case says 23s) isn't worth sleeping through inside
// this call — that would hang a user-facing connect-check or pipeline call for
// tens of seconds only to likely fail again — so it fails fast instead, carrying
// the hint on the thrown error for the caller to act on.
//
// Each attempt carries its own AbortSignal.timeout(): without one, a black-holed
// connection (packets silently dropped, not a fast connection-refused) hangs fetch()
// forever, since Node's global fetch has no default timeout. This bounds both the
// background pipeline calls this was originally written for and the newer synchronous,
// user-facing LLM-account connect-validation call, which would otherwise leave the
// browser's "Connect" button waiting indefinitely with no feedback.
export async function fetchWithRetry(
	provider: string,
	url: string,
	init: RequestInit,
	timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
	let lastNetworkError: unknown;
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		let res: Response;
		try {
			res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
		} catch (err) {
			lastNetworkError = err;
			if (attempt === MAX_ATTEMPTS) throw err;
			await delay(attempt);
			continue;
		}
		if (res.ok) return res;
		if (!RETRYABLE_STATUSES.has(res.status)) {
			throw new LlmApiError(provider, res.status, await res.text());
		}

		const bodyText = await res.text();
		const { retryAfterMs, quotaExceeded } = parseRetryInfo(bodyText);
		if (
			(retryAfterMs !== undefined && retryAfterMs > SHORT_RETRY_THRESHOLD_MS) ||
			attempt === MAX_ATTEMPTS
		) {
			throw new LlmApiError(provider, res.status, bodyText, retryAfterMs, quotaExceeded);
		}
		await delay(attempt, retryAfterMs);
	}
	throw lastNetworkError ?? new Error("unreachable");
}
