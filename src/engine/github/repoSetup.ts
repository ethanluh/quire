import type { GitHubClient } from "./client.js";

const PR_TEMPLATE_PATH = ".github/pull_request_template.md";
const WORKFLOW_PATH = ".github/workflows/quire-declared-direction.yml";
const SETUP_BRANCH = "quire/setup-declared-direction";
const DECLARED_DIRECTION_SUBSTRING = "declared-direction";

const DECLARED_DIRECTION_SECTION = `## Declared direction

<!-- declared-direction: one-sentence summary of this PR's product-direction intent -->

Quire ingests PRs by reading the \`declared-direction\` marker above. PRs missing it are silently skipped from the triage queue.
`;

const WORKFLOW_CONTENT = `name: Quire declared-direction check

on:
  pull_request:
    types: [opened, edited, reopened, synchronize]

jobs:
  check-declared-direction:
    runs-on: ubuntu-latest
    steps:
      - name: Verify declared-direction marker
        env:
          PR_BODY: \${{ github.event.pull_request.body }}
        run: |
          if ! printf '%s' "$PR_BODY" | grep -qP '<!--\\s*declared-direction:\\s*\\S.*-->'; then
            echo "::error::PR body is missing a <!-- declared-direction: ... --> marker. Quire will silently skip this PR without it."
            exit 1
          fi
`;

const SETUP_PR_TITLE = "Set up Quire's declared-direction PR convention";

const SETUP_PR_BODY = `<!-- declared-direction: Document and enforce the declared-direction PR convention Quire needs to ingest this repo's PRs -->

Quire ingests PRs by reading a \`<!-- declared-direction: ... -->\` marker from the PR body — PRs missing it are silently skipped from the triage queue. This PR:

- Adds a "Declared direction" section to the PR template so contributors know to include the marker.
- Adds a CI check (\`${WORKFLOW_PATH}\`) that fails a PR missing the marker.
`;

export type RepoSetupResult =
	| { status: "already-set-up" }
	| { status: "pr-open"; prNumber: number; prUrl: string }
	| { status: "created"; prNumber: number; prUrl: string };

function buildTemplateContent(existing: string | undefined): string {
	if (existing === undefined) return DECLARED_DIRECTION_SECTION;
	return `${DECLARED_DIRECTION_SECTION}\n${existing}`;
}

export async function setUpDeclaredDirectionConvention(
	client: GitHubClient,
	owner: string,
	name: string,
): Promise<RepoSetupResult> {
	const [template, workflow] = await Promise.all([
		client.getFileContent(owner, name, PR_TEMPLATE_PATH),
		client.getFileContent(owner, name, WORKFLOW_PATH),
	]);

	const templateConforms = template !== undefined && template.content.includes(DECLARED_DIRECTION_SUBSTRING);
	const workflowConforms = workflow !== undefined;

	if (templateConforms && workflowConforms) {
		return { status: "already-set-up" };
	}

	const defaultBranch = await client.getDefaultBranch(owner, name);

	if (!templateConforms) {
		await client.commitFileToBranch(
			owner,
			name,
			SETUP_BRANCH,
			PR_TEMPLATE_PATH,
			buildTemplateContent(template?.content),
			"Document the declared-direction PR convention",
		);
	}
	if (!workflowConforms) {
		await client.commitFileToBranch(
			owner,
			name,
			SETUP_BRANCH,
			WORKFLOW_PATH,
			WORKFLOW_CONTENT,
			"Add CI check for the declared-direction PR convention",
		);
	}

	const pr = await client.findOrCreatePullRequest(owner, name, {
		head: SETUP_BRANCH,
		base: defaultBranch,
		title: SETUP_PR_TITLE,
		body: SETUP_PR_BODY,
	});

	return pr.created
		? { status: "created", prNumber: pr.number, prUrl: pr.url }
		: { status: "pr-open", prNumber: pr.number, prUrl: pr.url };
}
