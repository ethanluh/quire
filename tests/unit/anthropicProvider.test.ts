import { describe, it, expect, jest, afterEach } from "@jest/globals";
import { AnthropicLlmProvider } from "../../src/engine/drift/effectList/anthropicProvider.js";

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

describe("AnthropicLlmProvider", () => {
	afterEach(() => {
		jest.restoreAllMocks();
	});

	it("sends the system message separately and turns the rest into the messages array", async () => {
		const fetchMock = mockFetchOnce(200, { content: [{ type: "text", text: '["adds OTP login"]' }] });
		const provider = new AnthropicLlmProvider({ apiKey: "sk-test" });

		const result = await provider.complete([
			{ role: "system", content: "You are a code analyst." },
			{ role: "user", content: "Diff: ..." },
		]);

		expect(result).toBe('["adds OTP login"]');
		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.anthropic.com/v1/messages",
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({ "x-api-key": "sk-test" }),
			}),
		);
		const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body);
		expect(body.system).toBe("You are a code analyst.");
		expect(body.messages).toEqual([{ role: "user", content: "Diff: ..." }]);
	});

	it("records the call on .calls for parity with the stub provider", async () => {
		mockFetchOnce(200, { content: [{ type: "text", text: "ok" }] });
		const provider = new AnthropicLlmProvider({ apiKey: "sk-test" });

		const messages = [{ role: "user" as const, content: "hello" }];
		await provider.complete(messages);

		expect(provider.calls).toEqual([{ messages, response: "ok" }]);
	});

	it("throws with the response body when the API returns a non-2xx status", async () => {
		mockFetchOnce(429, { error: { message: "rate limited" } });
		const provider = new AnthropicLlmProvider({ apiKey: "sk-test" });

		await expect(provider.complete([{ role: "user", content: "hi" }])).rejects.toThrow(/429/);
	});

	it("respects a custom baseUrl and model", async () => {
		const fetchMock = mockFetchOnce(200, { content: [{ type: "text", text: "ok" }] });
		const provider = new AnthropicLlmProvider({
			apiKey: "sk-test",
			baseUrl: "https://proxy.example.com",
			model: "claude-opus-4-8",
		});

		await provider.complete([{ role: "user", content: "hi" }]);

		expect(fetchMock).toHaveBeenCalledWith("https://proxy.example.com/v1/messages", expect.anything());
		const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body);
		expect(body.model).toBe("claude-opus-4-8");
	});

	it("embed() returns an empty vector so callers fall back to text similarity", async () => {
		const provider = new AnthropicLlmProvider({ apiKey: "sk-test" });
		await expect(provider.embed("some text")).resolves.toEqual([]);
	});
});
