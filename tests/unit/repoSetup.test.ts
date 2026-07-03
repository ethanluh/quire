import { describe, it, expect } from "@jest/globals";
import { StubGitHubClient } from "../../src/engine/github/stubClient.js";
import { WORKFLOW_CONTENT, setUpDeclaredDirectionConvention } from "../../src/engine/github/repoSetup.js";

const TEMPLATE_PATH = ".github/pull_request_template.md";
const WORKFLOW_PATH = ".github/workflows/quire-declared-direction.yml";

function seedFullyConformingRepo(client: StubGitHubClient): void {
	client.seedFile("acme-corp", "widgets", TEMPLATE_PATH, "## Declared direction\n\n<!-- declared-direction: ... -->\n");
	client.seedFile("acme-corp", "widgets", WORKFLOW_PATH, WORKFLOW_CONTENT);
}

describe("setUpDeclaredDirectionConvention", () => {
	it("opens a setup PR adding both the template section and the CI workflow when neither exists", async () => {
		const client = new StubGitHubClient();

		const result = await setUpDeclaredDirectionConvention(client, "acme-corp", "widgets");

		expect(result.status).toBe("created");
		if (result.status !== "created") throw new Error("expected created");
		expect(result.prUrl).toContain("acme-corp/widgets/pull/");

		const template = await client.getFileContent("acme-corp", "widgets", TEMPLATE_PATH);
		expect(template).toBeUndefined(); // written to the setup branch, not the default branch
	});

	it("preserves an existing PR template's content while adding the declared-direction section", async () => {
		const client = new StubGitHubClient();
		client.seedFile("acme-corp", "widgets", TEMPLATE_PATH, "## Summary\n\nExisting template.\n");

		const result = await setUpDeclaredDirectionConvention(client, "acme-corp", "widgets");

		expect(result.status).toBe("created");
	});

	it("reports already-set-up only once both files conform", async () => {
		const client = new StubGitHubClient();
		seedFullyConformingRepo(client);

		const result = await setUpDeclaredDirectionConvention(client, "acme-corp", "widgets");

		expect(result).toEqual({ status: "already-set-up" });
	});

	it("still creates a PR when the declared-direction workflow's content is stale (e.g. predates a fix)", async () => {
		const client = new StubGitHubClient();
		client.seedFile("acme-corp", "widgets", TEMPLATE_PATH, "## Declared direction\n\n<!-- declared-direction: ... -->\n");
		client.seedFile("acme-corp", "widgets", WORKFLOW_PATH, "name: an older version of the template\n");

		const result = await setUpDeclaredDirectionConvention(client, "acme-corp", "widgets");

		expect(result.status).toBe("created");
	});

	it("still creates a PR when only the declared-direction workflow is missing", async () => {
		const client = new StubGitHubClient();
		client.seedFile("acme-corp", "widgets", TEMPLATE_PATH, "## Declared direction\n\n<!-- declared-direction: ... -->\n");

		const result = await setUpDeclaredDirectionConvention(client, "acme-corp", "widgets");

		expect(result.status).toBe("created");
	});

	it("still creates a PR when only the PR template is missing", async () => {
		const client = new StubGitHubClient();
		client.seedFile("acme-corp", "widgets", WORKFLOW_PATH, WORKFLOW_CONTENT);

		const result = await setUpDeclaredDirectionConvention(client, "acme-corp", "widgets");

		expect(result.status).toBe("created");
	});

	it("returns the already-open setup PR instead of opening a duplicate on a second call", async () => {
		const client = new StubGitHubClient();

		const first = await setUpDeclaredDirectionConvention(client, "acme-corp", "widgets");
		const second = await setUpDeclaredDirectionConvention(client, "acme-corp", "widgets");

		expect(first.status).toBe("created");
		expect(second.status).toBe("pr-open");
		if (first.status === "created" && second.status === "pr-open") {
			expect(second.prNumber).toBe(first.prNumber);
		}
	});
});
