import { describe, it, expect } from "@jest/globals";
import { settleWithConcurrency } from "../../src/engine/util/concurrency.js";

describe("settleWithConcurrency", () => {
	it("settles every item, preserving input order in the results array", async () => {
		const results = await settleWithConcurrency([1, 2, 3, 4], 2, async (n) => n * 10);
		expect(results.map((r) => (r.status === "fulfilled" ? r.value : undefined))).toEqual([10, 20, 30, 40]);
	});

	it("never runs more than `limit` items concurrently", async () => {
		let inFlight = 0;
		let maxInFlight = 0;
		await settleWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (n) => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise((resolve) => setTimeout(resolve, 5));
			inFlight--;
			return n;
		});
		expect(maxInFlight).toBeLessThanOrEqual(2);
	});

	it("isolates a rejection to its own item instead of failing the whole batch", async () => {
		const results = await settleWithConcurrency([1, 2, 3], 3, async (n) => {
			if (n === 2) throw new Error("boom");
			return n;
		});
		expect(results[0]).toEqual({ status: "fulfilled", value: 1 });
		expect(results[1]?.status).toBe("rejected");
		expect(results[2]).toEqual({ status: "fulfilled", value: 3 });
	});

	it("handles an empty input", async () => {
		const results = await settleWithConcurrency([], 4, async (n: number) => n);
		expect(results).toEqual([]);
	});
});
