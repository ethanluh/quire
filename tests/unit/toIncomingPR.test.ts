import { describe, it, expect } from "@jest/globals";
import { rawPRPayloadToIncomingPR } from "../../src/engine/github/toIncomingPR.js";
import { validateIncomingPayload, normalizePR } from "../../src/engine/ingest/ingest.js";
import type { RawPRPayload } from "../../src/engine/github/client.js";

function makeRawPR(overrides: Partial<RawPRPayload> = {}): RawPRPayload {
	return {
		id: "12345",
		number: 7,
		owner: "octocat",
		repo: "hello-world",
		title: "Add OTP login",
		body: "adds OTP-based login",
		diff:
			"diff --git a/src/auth.ts b/src/auth.ts\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1,1 +1,1 @@\n+export function login() {}\n",
		ciStatus: "success",
		headSha: "sha-1",
		declaredDirection: "add passwordless auth",
		filesTouched: ["src/auth.ts"],
		...overrides,
	};
}

describe("rawPRPayloadToIncomingPR", () => {
	it("maps a GitHub-fetched PR into a schema-valid IncomingPR", () => {
		const incoming = rawPRPayloadToIncomingPR(makeRawPR());
		const validated = validateIncomingPayload(incoming);

		expect(validated.success).toBe(true);
		if (!validated.success) return;
		expect(validated.data).toMatchObject({
			id: "12345",
			repoOwner: "octocat",
			repoName: "hello-world",
			number: 7,
			declaredDirection: "add passwordless auth",
			filesTouched: ["src/auth.ts"],
			ciStatus: "success",
		});
	});

	it("reconstructs hunks from the raw diff so footprint analysis has symbols to see", () => {
		const incoming = rawPRPayloadToIncomingPR(makeRawPR());
		expect(incoming.diff.hunks).toEqual([
			{ filePath: "src/auth.ts", additions: ["+export function login() {}"], deletions: [] },
		]);
	});

	it("normalizes into a PullRequest usable by the pipeline", () => {
		const incoming = rawPRPayloadToIncomingPR(makeRawPR());
		const validated = validateIncomingPayload(incoming);
		expect(validated.success).toBe(true);
		if (!validated.success) return;

		const pr = normalizePR(validated.data);
		expect(pr.id).toBe("12345");
		expect(pr.repoOwner).toBe("octocat");
		expect(pr.repoName).toBe("hello-world");
		expect(pr.filesTouched).toEqual(["src/auth.ts"]);
	});
});
