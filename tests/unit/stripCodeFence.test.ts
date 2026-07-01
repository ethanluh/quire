import { describe, it, expect } from "@jest/globals";
import { stripCodeFence } from "../../src/engine/drift/effectList/stripCodeFence.js";

describe("stripCodeFence", () => {
	it("strips a ```json ... ``` fence", () => {
		expect(stripCodeFence('```json\n["adds OTP login"]\n```')).toBe('["adds OTP login"]');
	});

	it("strips a bare ``` fence with no language tag", () => {
		expect(stripCodeFence('```\n["adds OTP login"]\n```')).toBe('["adds OTP login"]');
	});

	it("leaves unfenced text unchanged", () => {
		expect(stripCodeFence('["adds OTP login"]')).toBe('["adds OTP login"]');
	});

	it("leaves non-JSON prose unchanged", () => {
		expect(stripCodeFence("garbage, not json")).toBe("garbage, not json");
	});
});
