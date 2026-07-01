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
});
