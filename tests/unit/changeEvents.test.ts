import { describe, it, expect } from "@jest/globals";
import { notifyStateChanged, onStateChanged } from "../../src/interface/server/changeEvents.js";

describe("changeEvents", () => {
	it("delivers notifyStateChanged() to every current subscriber", () => {
		const calls: Array<string> = [];
		const unsubscribeA = onStateChanged(() => calls.push("a"));
		const unsubscribeB = onStateChanged(() => calls.push("b"));

		notifyStateChanged();

		expect(calls.sort()).toEqual(["a", "b"]);
		unsubscribeA();
		unsubscribeB();
	});

	it("stops delivering to a listener once unsubscribed", () => {
		const calls: Array<string> = [];
		const unsubscribe = onStateChanged(() => calls.push("a"));
		unsubscribe();

		notifyStateChanged();

		expect(calls).toEqual([]);
	});

	it("is a no-op when there are no subscribers", () => {
		expect(() => notifyStateChanged()).not.toThrow();
	});
});
