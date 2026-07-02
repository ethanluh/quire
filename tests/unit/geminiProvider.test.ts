import { describe, it, expect, jest, afterEach } from "@jest/globals";
import { GeminiLlmProvider } from "../../src/engine/drift/effectList/geminiProvider.js";

function mockFetchOnce(status: number, body: unknown): jest.Mock {
	const fetchMock = jest.fn(async () => ({
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
		text: async () => JSON.stringify(body),
	}));
	global.fetch = fetchMock as unknown as typeof fetch;
	return fetchMock;
}

function requestUrl(fetchMock: jest.Mock): string {
	return (fetchMock.mock.calls[0] as unknown as [string, unknown])[0];
}

function requestBody(fetchMock: jest.Mock): Record<string, unknown> {
	return JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body);
}

describe("GeminiLlmProvider", () => {
	afterEach(() => {
		jest.restoreAllMocks();
	});

	describe("complete", () => {
		it("moves the system message to systemInstruction and maps assistant -> model", async () => {
			const fetchMock = mockFetchOnce(200, {
				candidates: [{ content: { parts: [{ text: '["adds OTP login"]' }] } }],
			});
			const provider = new GeminiLlmProvider({ apiKey: "gemini-test" });

			const result = await provider.complete([
				{ role: "system", content: "You are a code analyst." },
				{ role: "user", content: "Diff: ..." },
				{ role: "assistant", content: "prior reply" },
			]);

			expect(result).toBe('["adds OTP login"]');
			expect(requestUrl(fetchMock)).toBe(
				"https://generativelanguage.googleapis.com/v1beta/models/gemma-4-31b-it:generateContent?key=gemini-test",
			);
			const body = requestBody(fetchMock);
			expect(body["systemInstruction"]).toEqual({ parts: [{ text: "You are a code analyst." }] });
			expect(body["contents"]).toEqual([
				{ role: "user", parts: [{ text: "Diff: ..." }] },
				{ role: "model", parts: [{ text: "prior reply" }] },
			]);
		});

		it("records the call on .calls for parity with the other providers", async () => {
			mockFetchOnce(200, { candidates: [{ content: { parts: [{ text: "ok" }] } }] });
			const provider = new GeminiLlmProvider({ apiKey: "gemini-test" });

			const messages = [{ role: "user" as const, content: "hello" }];
			await provider.complete(messages);

			expect(provider.calls).toEqual([{ messages, response: "ok" }]);
		});

		it("throws with the response body when the API returns a non-2xx status", async () => {
			mockFetchOnce(403, { error: { message: "invalid key" } });
			const provider = new GeminiLlmProvider({ apiKey: "bad-key" });

			await expect(provider.complete([{ role: "user", content: "hi" }])).rejects.toThrow(/403/);
		});

		it("strips thinking-trace parts (thought: true) from the returned text", async () => {
			mockFetchOnce(200, {
				candidates: [
					{
						content: {
							parts: [
								{ text: "reasoning about the diff...", thought: true },
								{ text: '["adds OTP login"]' },
							],
						},
					},
				],
			});
			const provider = new GeminiLlmProvider({ apiKey: "gemini-test" });

			const result = await provider.complete([{ role: "user", content: "hi" }]);

			expect(result).toBe('["adds OTP login"]');
		});

		it("respects a custom baseUrl and model", async () => {
			const fetchMock = mockFetchOnce(200, { candidates: [{ content: { parts: [{ text: "ok" }] } }] });
			const provider = new GeminiLlmProvider({
				apiKey: "gemini-test",
				baseUrl: "https://proxy.example.com",
				model: "gemini-1.5-flash",
			});

			await provider.complete([{ role: "user", content: "hi" }]);

			expect(requestUrl(fetchMock)).toBe(
				"https://proxy.example.com/v1beta/models/gemini-1.5-flash:generateContent?key=gemini-test",
			);
		});
	});

	describe("embed", () => {
		it("returns the embedding values from the embedContent response", async () => {
			const fetchMock = mockFetchOnce(200, { embedding: { values: [0.1, 0.2, 0.3] } });
			const provider = new GeminiLlmProvider({ apiKey: "gemini-test" });

			const vec = await provider.embed("adds OTP login");

			expect(vec).toEqual([0.1, 0.2, 0.3]);
			expect(requestUrl(fetchMock)).toBe(
				"https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=gemini-test",
			);
		});

		it("throws with the response body when the API returns a non-2xx status", async () => {
			mockFetchOnce(500, { error: { message: "internal error" } });
			const provider = new GeminiLlmProvider({ apiKey: "gemini-test" });

			await expect(provider.embed("text")).rejects.toThrow(/500/);
		});
	});
});
