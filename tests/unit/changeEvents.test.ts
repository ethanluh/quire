import { describe, it, expect } from "@jest/globals";
import { notifyStateChanged, onStateChanged } from "../../src/interface/server/changeEvents.js";

describe("changeEvents", () => {
	it("delivers notifyStateChanged() to every current subscriber of that team", () => {
		const calls: Array<string> = [];
		const unsubscribeA = onStateChanged("team-a", () => calls.push("a"));
		const unsubscribeB = onStateChanged("team-a", () => calls.push("b"));

		notifyStateChanged("team-a");

		expect(calls.sort()).toEqual(["a", "b"]);
		unsubscribeA();
		unsubscribeB();
	});

	it("stops delivering to a listener once unsubscribed", () => {
		const calls: Array<string> = [];
		const unsubscribe = onStateChanged("team-a", () => calls.push("a"));
		unsubscribe();

		notifyStateChanged("team-a");

		expect(calls).toEqual([]);
	});

	it("is a no-op when there are no subscribers", () => {
		expect(() => notifyStateChanged("team-with-no-subscribers")).not.toThrow();
	});

	it("never delivers one team's notify to another team's subscriber", () => {
		const calls: Array<string> = [];
		const unsubscribe = onStateChanged("team-a", () => calls.push("a"));

		notifyStateChanged("team-b");

		expect(calls).toEqual([]);
		unsubscribe();
	});
});
