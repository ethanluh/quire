import { describe, it, expect, jest, afterEach } from "@jest/globals";
import { ciOutcomeFromCheckSuiteConclusion, performHealthCheck } from "../../src/engine/judge/verify.js";

function response(status: number) {
	return { ok: status >= 200 && status < 300, status };
}

describe("ciOutcomeFromCheckSuiteConclusion", () => {
	it("maps 'success' to success", () => {
		expect(ciOutcomeFromCheckSuiteConclusion("success")).toBe("success");
	});

	it("maps clear failure conclusions to failure", () => {
		expect(ciOutcomeFromCheckSuiteConclusion("failure")).toBe("failure");
		expect(ciOutcomeFromCheckSuiteConclusion("timed_out")).toBe("failure");
	});

	it("maps ambiguous conclusions to inconclusive, never to failure or success", () => {
		expect(ciOutcomeFromCheckSuiteConclusion("neutral")).toBe("inconclusive");
		expect(ciOutcomeFromCheckSuiteConclusion("cancelled")).toBe("inconclusive");
		expect(ciOutcomeFromCheckSuiteConclusion("skipped")).toBe("inconclusive");
		expect(ciOutcomeFromCheckSuiteConclusion("action_required")).toBe("inconclusive");
		expect(ciOutcomeFromCheckSuiteConclusion("stale")).toBe("inconclusive");
	});

	it("maps an in-progress suite (no conclusion yet) to inconclusive", () => {
		expect(ciOutcomeFromCheckSuiteConclusion(undefined)).toBe("inconclusive");
	});

	it("maps an unrecognized conclusion to inconclusive rather than guessing", () => {
		expect(ciOutcomeFromCheckSuiteConclusion("some-future-github-value")).toBe("inconclusive");
	});
});

describe("performHealthCheck", () => {
	afterEach(() => {
		jest.restoreAllMocks();
	});

	it("returns healthy on the first successful response, without exhausting retries", async () => {
		const fetchMock = jest.fn(async () => response(200));
		global.fetch = fetchMock as unknown as typeof fetch;

		const outcome = await performHealthCheck({ url: "https://example.com/health", delayMs: 1 });

		expect(outcome).toBe("healthy");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("returns unhealthy when every attempt gets an explicit bad response", async () => {
		const fetchMock = jest.fn(async () => response(503));
		global.fetch = fetchMock as unknown as typeof fetch;

		const outcome = await performHealthCheck({ url: "https://example.com/health", maxAttempts: 3, delayMs: 1 });

		expect(outcome).toBe("unhealthy");
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("returns unreachable when every attempt fails at the network level", async () => {
		const fetchMock = jest.fn(async () => {
			throw new Error("connect ECONNREFUSED");
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		const outcome = await performHealthCheck({ url: "https://example.com/health", maxAttempts: 3, delayMs: 1 });

		expect(outcome).toBe("unreachable");
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("recovers to healthy if a later retry succeeds after earlier attempts failed (absorbing deploy lag)", async () => {
		const fetchMock = jest
			.fn<() => Promise<unknown>>()
			.mockRejectedValueOnce(new Error("connect ECONNREFUSED"))
			.mockResolvedValueOnce(response(200));
		global.fetch = fetchMock as unknown as typeof fetch;

		const outcome = await performHealthCheck({ url: "https://example.com/health", maxAttempts: 3, delayMs: 1 });

		expect(outcome).toBe("healthy");
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("treats a reachable-but-bad final attempt as unhealthy even if earlier attempts were network failures", async () => {
		const fetchMock = jest
			.fn<() => Promise<unknown>>()
			.mockRejectedValueOnce(new Error("connect ECONNREFUSED"))
			.mockResolvedValueOnce(response(500));
		global.fetch = fetchMock as unknown as typeof fetch;

		const outcome = await performHealthCheck({ url: "https://example.com/health", maxAttempts: 2, delayMs: 1 });

		expect(outcome).toBe("unhealthy");
	});
});
