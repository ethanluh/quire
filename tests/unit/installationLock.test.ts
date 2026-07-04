import { describe, it, expect } from "@jest/globals";
import { withInstallationLock } from "../../src/engine/github/installationLock.js";

describe("withInstallationLock", () => {
	it("runs calls for the same key strictly one after another", async () => {
		const order: string[] = [];
		let releaseFirst: () => void = () => undefined;
		const first = withInstallationLock("team-a", async () => {
			order.push("first-start");
			await new Promise<void>((resolve) => (releaseFirst = resolve));
			order.push("first-end");
		});
		const second = withInstallationLock("team-a", async () => {
			order.push("second-start");
		});

		// second must not have started yet — it's queued behind first, which hasn't released.
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(order).toEqual(["first-start"]);

		releaseFirst();
		await Promise.all([first, second]);
		expect(order).toEqual(["first-start", "first-end", "second-start"]);
	});

	it("runs calls for different keys concurrently, not serialized against each other", async () => {
		const order: string[] = [];
		let releaseA: () => void = () => undefined;
		const a = withInstallationLock("team-a", async () => {
			order.push("a-start");
			await new Promise<void>((resolve) => (releaseA = resolve));
			order.push("a-end");
		});
		const b = withInstallationLock("team-b", async () => {
			order.push("b-start");
		});

		await b;
		expect(order).toEqual(["a-start", "b-start"]);

		releaseA();
		await a;
		expect(order).toEqual(["a-start", "b-start", "a-end"]);
	});

	it("a rejected call doesn't jam the queue for later calls on the same key", async () => {
		const first = withInstallationLock("team-c", async () => {
			throw new Error("boom");
		});
		await expect(first).rejects.toThrow("boom");

		const second = withInstallationLock("team-c", async () => "ok");
		await expect(second).resolves.toBe("ok");
	});

	it("returns the wrapped function's resolved value", async () => {
		const result = await withInstallationLock("team-d", async () => ({ owner: "acme-corp", name: "widgets" }));
		expect(result).toEqual({ owner: "acme-corp", name: "widgets" });
	});
});
