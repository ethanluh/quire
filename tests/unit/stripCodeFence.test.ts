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

	it("strips a fence preceded by prose", () => {
		expect(stripCodeFence('Here is the result:\n```json\n["adds OTP login"]\n```')).toBe('["adds OTP login"]');
	});

	it("strips a fence followed by prose", () => {
		expect(stripCodeFence('```json\n["adds OTP login"]\n```\nLet me know if you need anything else.')).toBe(
			'["adds OTP login"]',
		);
	});

	it("strips a fence with a non-json language tag, discarding the tag", () => {
		expect(stripCodeFence('```javascript\n["adds OTP login"]\n```')).toBe('["adds OTP login"]');
	});

	it("extracts only the first fenced block when there are multiple", () => {
		expect(stripCodeFence('```json\n["a"]\n```\nsome text\n```json\n["b"]\n```')).toBe('["a"]');
	});
});
