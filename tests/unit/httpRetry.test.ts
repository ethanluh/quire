import { describe, it, expect, jest, afterEach } from "@jest/globals";
import { fetchWithRetry, LlmApiError } from "../../src/engine/drift/effectList/httpRetry.js";

function jsonResponse(status: number, body: unknown) {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
		text: async () => JSON.stringify(body),
	};
}

// Mirrors Gemini's real RESOURCE_EXHAUSTED body shape (the incident this covers):
// a `status` field plus a google.rpc.RetryInfo detail carrying the suggested wait.
function geminiQuotaExceededBody(retryDelay: string) {
	return {
		error: {
			code: 429,
			message: `Quota exceeded for metric: generate_content_free_tier_requests. Please retry in ${retryDelay}.`,
			status: "RESOURCE_EXHAUSTED",
			details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay }],
		},
	};
}

describe("fetchWithRetry", () => {
	afterEach(() => {
		jest.restoreAllMocks();
	});

	it("returns immediately on a successful response", async () => {
		const fetchMock = jest.fn(async () => jsonResponse(200, { ok: true }));
		global.fetch = fetchMock as unknown as typeof fetch;

		await fetchWithRetry("Test", "https://example.com", {});

		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("retries a 429 and succeeds once the response turns healthy", async () => {
		const fetchMock = jest.fn<() => Promise<unknown>>();
		fetchMock
			.mockResolvedValueOnce(jsonResponse(429, { error: "rate limited" }))
			.mockResolvedValueOnce(jsonResponse(200, { ok: true }));
		global.fetch = fetchMock as unknown as typeof fetch;

		const res = await fetchWithRetry("Test", "https://example.com", {});

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(res.status).toBe(200);
	});

	it("throws LlmApiError with the status preserved after exhausting retries on a 429", async () => {
		const fetchMock = jest.fn(async () => jsonResponse(429, { error: "rate limited" }));
		global.fetch = fetchMock as unknown as typeof fetch;

		await expect(fetchWithRetry("Test", "https://example.com", {})).rejects.toMatchObject({
			status: 429,
			provider: "Test",
		});
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("does not retry a non-retryable status like 403", async () => {
		const fetchMock = jest.fn(async () => jsonResponse(403, { error: "forbidden" }));
		global.fetch = fetchMock as unknown as typeof fetch;

		await expect(fetchWithRetry("Test", "https://example.com", {})).rejects.toBeInstanceOf(LlmApiError);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("retries a network-level fetch() rejection (e.g. DNS/connection failure)", async () => {
		const fetchMock = jest.fn<() => Promise<unknown>>();
		fetchMock
			.mockRejectedValueOnce(new TypeError("fetch failed"))
			.mockResolvedValueOnce(jsonResponse(200, { ok: true }));
		global.fetch = fetchMock as unknown as typeof fetch;

		const res = await fetchWithRetry("Test", "https://example.com", {});

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(res.status).toBe(200);
	});

	it("re-throws the original network error (not wrapped in LlmApiError) after exhausting retries", async () => {
		const networkError = new TypeError("fetch failed");
		const fetchMock = jest.fn(async () => {
			throw networkError;
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		await expect(fetchWithRetry("Test", "https://example.com", {})).rejects.toBe(networkError);
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("retries a 429 using a short server-suggested retryDelay, and can still succeed", async () => {
		const fetchMock = jest.fn<() => Promise<unknown>>();
		fetchMock
			.mockResolvedValueOnce(jsonResponse(429, geminiQuotaExceededBody("0.05s")))
			.mockResolvedValueOnce(jsonResponse(200, { ok: true }));
		global.fetch = fetchMock as unknown as typeof fetch;

		const res = await fetchWithRetry("Gemini", "https://example.com", {});

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(res.status).toBe(200);
	});

	it("fails fast on a 429 with a long server-suggested retryDelay instead of burning all attempts", async () => {
		const fetchMock = jest.fn(async () => jsonResponse(429, geminiQuotaExceededBody("23s")));
		global.fetch = fetchMock as unknown as typeof fetch;

		let caught: unknown;
		try {
			await fetchWithRetry("Gemini", "https://example.com", {});
		} catch (err) {
			caught = err;
		}

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(caught).toBeInstanceOf(LlmApiError);
		expect((caught as LlmApiError).retryAfterMs).toBe(23_000);
		expect((caught as LlmApiError).message).toMatch(/quota exceeded/i);
	});

	it("falls back to linear backoff when the error body isn't parseable JSON", async () => {
		const fetchMock = jest.fn(async () => ({
			ok: false,
			status: 429,
			json: async () => {
				throw new Error("not json");
			},
			text: async () => "Service Unavailable",
		}));
		global.fetch = fetchMock as unknown as typeof fetch;

		await expect(fetchWithRetry("Test", "https://example.com", {})).rejects.toMatchObject({
			status: 429,
			retryAfterMs: undefined,
		});
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("passes an AbortSignal to fetch so a request can be bounded by a timeout", async () => {
		const fetchMock = jest.fn((_url: string, _init: RequestInit) => Promise.resolve(jsonResponse(200, { ok: true })));
		global.fetch = fetchMock as unknown as typeof fetch;

		await fetchWithRetry("Test", "https://example.com", {});

		const callInit = fetchMock.mock.calls[0]?.[1];
		expect(callInit?.signal).toBeInstanceOf(AbortSignal);
	});

	it("aborts a hung request instead of waiting forever, once the per-attempt timeout elapses", async () => {
		// Simulates a black-holed connection: fetch() never resolves on its own, only
		// reacting to the abort signal — the same way a real fetch() implementation would.
		const fetchMock = jest.fn((_url: string, init: RequestInit) => {
			return new Promise((_resolve, reject) => {
				const signal = init.signal as AbortSignal;
				const onAbort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
				if (signal.aborted) {
					onAbort();
					return;
				}
				signal.addEventListener("abort", onAbort);
			});
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		await expect(fetchWithRetry("Test", "https://example.com", {}, 20)).rejects.toThrow(/aborted/i);
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});
});
