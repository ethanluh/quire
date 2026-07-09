import { describe, it, expect, jest, afterEach } from "@jest/globals";
import { NoopSlackNotifier, WebhookSlackNotifier, resolveSlackNotifier } from "../../src/interface/notify/slack.js";
import type { SlackEscalationMessage, SlackOutcomeMessage } from "../../src/interface/notify/slack.js";

function textResponse(status: number, body: string) {
	return { ok: status >= 200 && status < 300, status, text: async () => body };
}

const OUTCOME: SlackOutcomeMessage = {
	kind: "auto-merged-and-verified",
	bundleId: "bundle-1",
	directionSummary: "add passwordless auth",
	rationale: "clean extension of an accepted precedent",
	links: [{ label: "org/repo#1", url: "https://github.com/org/repo/pull/1" }],
};

const ESCALATION: SlackEscalationMessage = {
	bundleId: "bundle-1",
	directionSummary: "add passwordless auth",
	reason: "confidence below threshold",
	rationale: "borderline case",
	links: [],
};

describe("resolveSlackNotifier", () => {
	it("returns a NoopSlackNotifier when the webhook URL is unset", () => {
		expect(resolveSlackNotifier(undefined)).toBeInstanceOf(NoopSlackNotifier);
		expect(resolveSlackNotifier("")).toBeInstanceOf(NoopSlackNotifier);
	});

	it("returns a WebhookSlackNotifier when a webhook URL is configured", () => {
		expect(resolveSlackNotifier("https://hooks.slack.com/services/x")).toBeInstanceOf(WebhookSlackNotifier);
	});
});

describe("NoopSlackNotifier", () => {
	it("never throws and never calls fetch", async () => {
		const fetchMock = jest.fn();
		global.fetch = fetchMock as unknown as typeof fetch;
		const notifier = new NoopSlackNotifier();

		await expect(notifier.notifyOutcome(OUTCOME)).resolves.toBeUndefined();
		await expect(notifier.notifyEscalation(ESCALATION)).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("WebhookSlackNotifier", () => {
	afterEach(() => {
		jest.restoreAllMocks();
	});

	it("posts a JSON text payload to the configured webhook URL for an outcome", async () => {
		const fetchMock = jest.fn(async () => textResponse(200, "ok"));
		global.fetch = fetchMock as unknown as typeof fetch;
		const notifier = new WebhookSlackNotifier("https://hooks.slack.com/services/x");

		await notifier.notifyOutcome(OUTCOME);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("https://hooks.slack.com/services/x");
		const body = JSON.parse(init.body as string) as { text: string };
		expect(body.text).toContain("bundle-1");
		expect(body.text).toContain("add passwordless auth");
	});

	it("posts to the same webhook for an escalation, with a distinct headline", async () => {
		const fetchMock = jest.fn(async () => textResponse(200, "ok"));
		global.fetch = fetchMock as unknown as typeof fetch;
		const notifier = new WebhookSlackNotifier("https://hooks.slack.com/services/x");

		await notifier.notifyEscalation(ESCALATION);

		const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string) as { text: string };
		expect(body.text).toContain("needs a human");
		expect(body.text).toContain("confidence below threshold");
	});

	it("never throws when the webhook responds with an error status", async () => {
		const fetchMock = jest.fn(async () => textResponse(500, "server error"));
		global.fetch = fetchMock as unknown as typeof fetch;
		const notifier = new WebhookSlackNotifier("https://hooks.slack.com/services/x");

		await expect(notifier.notifyOutcome(OUTCOME)).resolves.toBeUndefined();
	});

	it("never throws when fetch itself rejects", async () => {
		const fetchMock = jest.fn(async () => {
			throw new Error("network down");
		});
		global.fetch = fetchMock as unknown as typeof fetch;
		const notifier = new WebhookSlackNotifier("https://hooks.slack.com/services/x");

		await expect(notifier.notifyEscalation(ESCALATION)).resolves.toBeUndefined();
	});
});
