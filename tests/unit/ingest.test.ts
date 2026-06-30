import { describe, it, expect } from "@jest/globals";
import { normalizePR, validateIncomingPayload } from "../../src/ingest/ingest.js";

const BASE_PAYLOAD = {
	id: "pr-1",
	repoOwner: "org",
	repoName: "repo",
	number: 1,
	declaredDirection: "add passwordless auth",
	diff: {
		raw: "",
		hunks: [],
	},
	ciStatus: "success" as const,
};

describe("validateIncomingPayload", () => {
	it("accepts a valid payload", () => {
		const result = validateIncomingPayload(BASE_PAYLOAD);
		expect(result.success).toBe(true);
	});

	it("rejects missing declaredDirection", () => {
		const result = validateIncomingPayload({ ...BASE_PAYLOAD, declaredDirection: undefined });
		expect(result.success).toBe(false);
	});

	it("defaults ciStatus to unknown", () => {
		const { ciStatus: _, ...without } = BASE_PAYLOAD;
		const result = validateIncomingPayload(without);
		expect(result.success).toBe(true);
		if (result.success) expect(result.data.ciStatus).toBe("unknown");
	});
});

describe("normalizePR", () => {
	it("derives filesTouched from diff hunks when not provided", () => {
		const payload = {
			...BASE_PAYLOAD,
			diff: {
				raw: "",
				hunks: [
					{ filePath: "src/auth.ts", additions: [], deletions: [] },
					{ filePath: "src/auth.ts", additions: [], deletions: [] },
					{ filePath: "src/db.ts", additions: [], deletions: [] },
				],
			},
		};
		const validated = validateIncomingPayload(payload);
		expect(validated.success).toBe(true);
		if (!validated.success) return;
		const pr = normalizePR(validated.data);
		expect(pr.filesTouched).toEqual(["src/auth.ts", "src/db.ts"]);
	});

	it("extracts test names from diff additions in test files", () => {
		const payload = {
			...BASE_PAYLOAD,
			diff: {
				raw: "+  it('should log in without password', () => {",
				hunks: [
					{
						filePath: "src/auth.test.ts",
						additions: ["+  it('should log in without password', () => {"],
						deletions: [],
					},
				],
			},
		};
		const validated = validateIncomingPayload(payload);
		expect(validated.success).toBe(true);
		if (!validated.success) return;
		const pr = normalizePR(validated.data);
		expect(pr.testNamesChanged).toContain("should log in without password");
	});
});
