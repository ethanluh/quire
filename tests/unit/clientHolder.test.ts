import { describe, it, expect } from "@jest/globals";
import { GitHubClientHolder } from "../../src/engine/github/clientHolder.js";
import { StubGitHubClient } from "../../src/engine/github/stubClient.js";
import type { RawPRPayload } from "../../src/engine/github/client.js";

function makeFixture(number: number): RawPRPayload {
	return {
		id: `pr-${number}`,
		number,
		owner: "org",
		repo: "repo",
		title: "t",
		body: "",
		diff: "",
		headSha: `sha-${number}`,
		ciStatus: "success",
		declaredDirection: "direction",
		filesTouched: [],
	};
}

describe("GitHubClientHolder", () => {
	it("delegates to the initial client", async () => {
		const first = new StubGitHubClient();
		first.addFixture("org", "repo", makeFixture(1));
		const holder = new GitHubClientHolder(first);

		const pr = await holder.getPullRequest("org", "repo", 1);

		expect(pr.id).toBe("pr-1");
	});

	it("delegates to a newly set client after setClient", async () => {
		const first = new StubGitHubClient();
		const second = new StubGitHubClient();
		second.addFixture("org", "repo", makeFixture(2));
		const holder = new GitHubClientHolder(first);

		holder.setClient(second);
		await holder.mergePullRequest("org", "repo", 2);

		expect(second.mergedPrs).toEqual(["org/repo/2"]);
		expect(first.mergedPrs).toEqual([]);
	});

	it("delegates createWebhook to the current client", async () => {
		const client = new StubGitHubClient();
		const holder = new GitHubClientHolder(client);

		const result = await holder.createWebhook("org", "repo", { url: "https://example.com/hook", secret: "s3cr3t" });

		expect(result).toEqual({ id: expect.any(Number) });
		expect(client.createdWebhooks).toEqual([{ owner: "org", repo: "repo", url: "https://example.com/hook", id: result.id }]);
	});

	it("delegates deleteWebhook to the current client", async () => {
		const client = new StubGitHubClient();
		const holder = new GitHubClientHolder(client);

		await holder.deleteWebhook("org", "repo", 42);

		expect(client.deletedWebhooks).toEqual([{ owner: "org", repo: "repo", hookId: 42 }]);
	});
});
