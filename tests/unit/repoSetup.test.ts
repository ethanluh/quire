import { describe, it, expect } from "@jest/globals";
import { StubGitHubClient } from "../../src/engine/github/stubClient.js";
import {
	DECLARED_DIRECTION_SECTION,
	WORKFLOW_CONTENT,
	CLAUDE_MD_SECTION,
	CLAUDE_HOOK_SCRIPT_CONTENT,
	CLAUDE_SETTINGS_CONTENT,
	GIT_HOOK_CONTENT,
	checkDeclaredDirectionConvention,
	setUpDeclaredDirectionConvention,
} from "../../src/engine/github/repoSetup.js";

const TEMPLATE_PATH = ".github/pull_request_template.md";
const WORKFLOW_PATH = ".github/workflows/quire-declared-direction.yml";
const CLAUDE_MD_PATH = "CLAUDE.md";
const CLAUDE_HOOK_SCRIPT_PATH = ".claude/hooks/check-declared-direction.sh";
const CLAUDE_SETTINGS_PATH = ".claude/settings.json";
const GIT_HOOK_PATH = ".githooks/pre-push";

function seedFullyConformingRepo(client: StubGitHubClient): void {
	client.seedFile("acme-corp", "widgets", TEMPLATE_PATH, DECLARED_DIRECTION_SECTION);
	client.seedFile("acme-corp", "widgets", WORKFLOW_PATH, WORKFLOW_CONTENT);
	client.seedFile("acme-corp", "widgets", CLAUDE_MD_PATH, CLAUDE_MD_SECTION);
	client.seedFile("acme-corp", "widgets", CLAUDE_HOOK_SCRIPT_PATH, CLAUDE_HOOK_SCRIPT_CONTENT);
	client.seedFile("acme-corp", "widgets", CLAUDE_SETTINGS_PATH, CLAUDE_SETTINGS_CONTENT);
	client.seedFile("acme-corp", "widgets", GIT_HOOK_PATH, GIT_HOOK_CONTENT);
}

describe("setUpDeclaredDirectionConvention", () => {
	it("opens a setup PR adding every item when none exist", async () => {
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

	it("preserves an existing CLAUDE.md's content while adding the declared-direction section", async () => {
		const client = new StubGitHubClient();
		client.seedFile("acme-corp", "widgets", CLAUDE_MD_PATH, "# widgets\n\nExisting project doc.\n");

		const result = await setUpDeclaredDirectionConvention(client, "acme-corp", "widgets");

		expect(result.status).toBe("created");
	});

	it("reports already-set-up only once every item conforms", async () => {
		const client = new StubGitHubClient();
		seedFullyConformingRepo(client);

		const result = await setUpDeclaredDirectionConvention(client, "acme-corp", "widgets");

		expect(result).toEqual({ status: "already-set-up" });
	});

	it("still creates a PR when the declared-direction workflow's content is stale (e.g. predates a fix)", async () => {
		const client = new StubGitHubClient();
		seedFullyConformingRepo(client);
		client.seedFile("acme-corp", "widgets", WORKFLOW_PATH, "name: an older version of the template\n");

		const result = await setUpDeclaredDirectionConvention(client, "acme-corp", "widgets");

		expect(result.status).toBe("created");
	});

	it("still creates a PR when only the CLAUDE.md section is missing", async () => {
		const client = new StubGitHubClient();
		client.seedFile("acme-corp", "widgets", TEMPLATE_PATH, DECLARED_DIRECTION_SECTION);
		client.seedFile("acme-corp", "widgets", WORKFLOW_PATH, WORKFLOW_CONTENT);
		client.seedFile("acme-corp", "widgets", CLAUDE_HOOK_SCRIPT_PATH, CLAUDE_HOOK_SCRIPT_CONTENT);
		client.seedFile("acme-corp", "widgets", CLAUDE_SETTINGS_PATH, CLAUDE_SETTINGS_CONTENT);
		client.seedFile("acme-corp", "widgets", GIT_HOOK_PATH, GIT_HOOK_CONTENT);

		const result = await setUpDeclaredDirectionConvention(client, "acme-corp", "widgets");

		expect(result.status).toBe("created");
		const claudeMd = await client.getFileContent("acme-corp", "widgets", CLAUDE_MD_PATH);
		expect(claudeMd).toBeUndefined(); // written to the setup branch, not the default branch
	});

	it("still creates a PR when only the Claude Code hook (script + settings) is missing", async () => {
		const client = new StubGitHubClient();
		client.seedFile("acme-corp", "widgets", TEMPLATE_PATH, DECLARED_DIRECTION_SECTION);
		client.seedFile("acme-corp", "widgets", WORKFLOW_PATH, WORKFLOW_CONTENT);
		client.seedFile("acme-corp", "widgets", CLAUDE_MD_PATH, CLAUDE_MD_SECTION);
		client.seedFile("acme-corp", "widgets", GIT_HOOK_PATH, GIT_HOOK_CONTENT);

		const result = await setUpDeclaredDirectionConvention(client, "acme-corp", "widgets");

		expect(result.status).toBe("created");
	});

	it("still creates a PR when .claude/settings.json exists but lacks our hook entry, without needing to touch unrelated settings", async () => {
		const client = new StubGitHubClient();
		const existingSettings = JSON.stringify(
			{
				permissions: { allow: ["Bash(npm test:*)"] },
				hooks: { PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "echo done" }] }] },
			},
			null,
			"\t",
		);
		client.seedFile("acme-corp", "widgets", CLAUDE_SETTINGS_PATH, existingSettings);

		const result = await setUpDeclaredDirectionConvention(client, "acme-corp", "widgets");

		expect(result.status).toBe("created");
	});

	it("treats .claude/settings.json as conforming once our hook entry is present, regardless of other unrelated settings", async () => {
		const client = new StubGitHubClient();
		seedFullyConformingRepo(client);
		const mergedWithExtras = {
			permissions: { allow: ["Bash(npm test:*)"] },
			hooks: {
				PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "echo done" }] }],
				PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `bash ${CLAUDE_HOOK_SCRIPT_PATH}` }] }],
			},
		};
		client.seedFile("acme-corp", "widgets", CLAUDE_SETTINGS_PATH, `${JSON.stringify(mergedWithExtras, null, "\t")}\n`);

		await expect(checkDeclaredDirectionConvention(client, "acme-corp", "widgets")).resolves.toBe(true);
	});

	it("treats a stale CLAUDE.md section as non-conforming instead of silently as already set up", async () => {
		const client = new StubGitHubClient();
		seedFullyConformingRepo(client);
		const staleSection = "## Declared direction\n\n<!-- declared-direction: ... -->\n";
		client.seedFile("acme-corp", "widgets", CLAUDE_MD_PATH, `${staleSection}\n# widgets\n\nExisting project doc.\n`);

		await expect(checkDeclaredDirectionConvention(client, "acme-corp", "widgets")).resolves.toBe(false);

		const result = await setUpDeclaredDirectionConvention(client, "acme-corp", "widgets");

		expect(result.status).toBe("created");
		const claudeMd = await client.getFileContentOnBranch("acme-corp", "widgets", "quire/setup-declared-direction", CLAUDE_MD_PATH);
		// Prepended rather than replaced in place — see appendSectionResolver's comment on why.
		expect(claudeMd?.content).toBe(`${CLAUDE_MD_SECTION}\n${staleSection}\n# widgets\n\nExisting project doc.\n`);
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

describe("checkDeclaredDirectionConvention", () => {
	it("returns true when every item already conforms", async () => {
		const client = new StubGitHubClient();
		seedFullyConformingRepo(client);

		await expect(checkDeclaredDirectionConvention(client, "acme-corp", "widgets")).resolves.toBe(true);
	});

	it("returns false when nothing exists", async () => {
		const client = new StubGitHubClient();

		await expect(checkDeclaredDirectionConvention(client, "acme-corp", "widgets")).resolves.toBe(false);
	});

	it("returns false when the workflow content is stale", async () => {
		const client = new StubGitHubClient();
		seedFullyConformingRepo(client);
		client.seedFile("acme-corp", "widgets", WORKFLOW_PATH, "name: an older version of the template\n");

		await expect(checkDeclaredDirectionConvention(client, "acme-corp", "widgets")).resolves.toBe(false);
	});

	it("returns false when the Claude Code hook script is missing", async () => {
		const client = new StubGitHubClient();
		client.seedFile("acme-corp", "widgets", TEMPLATE_PATH, DECLARED_DIRECTION_SECTION);
		client.seedFile("acme-corp", "widgets", WORKFLOW_PATH, WORKFLOW_CONTENT);
		client.seedFile("acme-corp", "widgets", CLAUDE_MD_PATH, CLAUDE_MD_SECTION);
		client.seedFile("acme-corp", "widgets", CLAUDE_SETTINGS_PATH, CLAUDE_SETTINGS_CONTENT);
		client.seedFile("acme-corp", "widgets", GIT_HOOK_PATH, GIT_HOOK_CONTENT);

		await expect(checkDeclaredDirectionConvention(client, "acme-corp", "widgets")).resolves.toBe(false);
	});

	it("performs no mutation — a repo needing setup stays untouched after a check", async () => {
		const client = new StubGitHubClient();

		await checkDeclaredDirectionConvention(client, "acme-corp", "widgets");

		const template = await client.getFileContent("acme-corp", "widgets", TEMPLATE_PATH);
		const workflow = await client.getFileContent("acme-corp", "widgets", WORKFLOW_PATH);
		const claudeMd = await client.getFileContent("acme-corp", "widgets", CLAUDE_MD_PATH);
		const settings = await client.getFileContent("acme-corp", "widgets", CLAUDE_SETTINGS_PATH);
		expect(template).toBeUndefined();
		expect(workflow).toBeUndefined();
		expect(claudeMd).toBeUndefined();
		expect(settings).toBeUndefined();
	});
});
