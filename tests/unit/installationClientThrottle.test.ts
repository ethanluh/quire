import { describe, it, expect } from "@jest/globals";
import { shouldRetryRateLimit } from "../../src/engine/github/installationClient.js";

describe("shouldRetryRateLimit", () => {
	it("retries a short rate-limit wait within the retry-count budget", () => {
		expect(shouldRetryRateLimit(5, 0)).toBe(true);
		expect(shouldRetryRateLimit(5, 1)).toBe(true);
	});

	it("refuses to retry once retryCount reaches the cap, regardless of how short the wait is", () => {
		expect(shouldRetryRateLimit(1, 2)).toBe(false);
	});

	it("refuses to retry a long Retry-After even on the very first attempt, so a refresh can't hang out GitHub's suggested backoff", () => {
		expect(shouldRetryRateLimit(120, 0)).toBe(false);
	});
});
