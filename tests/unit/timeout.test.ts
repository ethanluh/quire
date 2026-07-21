import { describe, it, expect } from "@jest/globals";
import { withTimeout } from "../../src/engine/util/timeout.js";

describe("withTimeout", () => {
	it("resolves with the promise's value when it settles before the deadline", async () => {
		const result = await withTimeout(Promise.resolve("done"), 50, () => new Error("timed out"));
		expect(result).toBe("done");
	});

	it("propagates a rejection that happens before the deadline", async () => {
		await expect(withTimeout(Promise.reject(new Error("boom")), 50, () => new Error("timed out"))).rejects.toThrow("boom");
	});

	it("rejects with the timeout error once the deadline passes, even though the original promise never settles", async () => {
		const neverResolves = new Promise(() => {});
		await expect(withTimeout(neverResolves, 10, () => new Error("timed out"))).rejects.toThrow("timed out");
	});
});
