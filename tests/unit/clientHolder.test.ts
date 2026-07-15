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
		directionInferred: false,
		filesTouched: [],
		labels: [],
		assignees: [],
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
});
