import type { GitHubClient } from "./client.js";

const PR_TEMPLATE_PATH = ".github/pull_request_template.md";
const WORKFLOW_PATH = ".github/workflows/quire-declared-direction.yml";
// Exported so octokitClient.ts's dispatchConflictResolution() can target the exact file this
// module is responsible for creating — single source of truth for the path.
export const CONFLICT_RESOLUTION_WORKFLOW_PATH = ".github/workflows/quire-resolve-conflict.yml";
const CLAUDE_MD_PATH = "CLAUDE.md";
const SETUP_BRANCH = "quire/setup-declared-direction";
const DECLARED_DIRECTION_SUBSTRING = "declared-direction";
const CONFLICT_RESOLUTION_SUBSTRING = "Quire conflict-resolution guidance";

const DECLARED_DIRECTION_SECTION = `## Declared direction

<!-- declared-direction: one-sentence summary of this PR's product-direction intent -->

Quire ingests PRs by reading the \`declared-direction\` marker above. PRs missing it are silently skipped from the triage queue.
`;

// Exported so tests can seed a repo whose committed copy already matches, and so an already
// content-conforming repo is distinguishable from one carrying a stale, pre-fix version.
export const WORKFLOW_CONTENT = `name: Quire declared-direction check

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

// workflow_dispatch inputs are all strings; the job re-merges the branch itself (rather than
// receiving pre-computed conflict content) so it's a self-sufficient normal git checkout, and
// verifies its own output before pushing rather than trusting the model's edit outright.
export const CONFLICT_RESOLUTION_WORKFLOW_CONTENT = `name: Quire conflict resolution

on:
  workflow_dispatch:
    inputs:
      pr_number:
        required: true
        type: string
      head_branch:
        required: true
        type: string
      base_branch:
        required: true
        type: string
      declared_direction:
        required: true
        type: string
      callback_url:
        required: true
        type: string
      callback_token:
        required: true
        type: string

jobs:
  resolve-conflict:
    runs-on: ubuntu-latest
    # Confirmed against a live run (28638454529): with no permission-mode/max-turns set, Claude
    # burned 25 turns and hit 8 tool-permission denials working around the interactive-style
    # default, took 8m27s, and still left conflict markers behind. This job's checkout is
    # disposable and single-purpose (contents: write only), so bypassPermissions is safe here.
    # A follow-up run (28639881277) confirmed bypassPermissions eliminated the denials (0, down
    # from 8) but hit an initial max-turns of 15 anyway: it was a genuine semantic conflict (two
    # branches independently reshaping the same constructor), and cross-referencing HEAD vs.
    # MERGE_HEAD across five files ate all 15 turns before a single edit landed. Sized up to give
    # that kind of investigation-then-edit conflict room to actually finish, while still bounding
    # the worst case well below GitHub's 6-hour default.
    timeout-minutes: 25
    permissions:
      contents: write
      # claude-code-action authenticates via GitHub's OIDC provider, which requires this
      # even though the job never uses the token directly.
      id-token: write
    steps:
      - uses: actions/checkout@v4
        with:
          ref: \${{ github.event.inputs.head_branch }}
          fetch-depth: 0

      - name: Reproduce the conflict
        run: |
          git config user.name "quire-bot"
          git config user.email "quire-bot@users.noreply.github.com"
          git fetch origin "\${{ github.event.inputs.base_branch }}"
          git merge "origin/\${{ github.event.inputs.base_branch }}" --no-edit || true

      - name: Resolve remaining conflicts with Claude Code
        uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: \${{ secrets.ANTHROPIC_API_KEY }}
          # Dispatched via Quire's own GitHub App installation token, so the triggering actor
          # is always whatever bot dispatched this run — never hardcode a specific app slug
          # here, since every Quire installation registers its own app under its own name.
          allowed_bots: \${{ github.actor }}
          claude_args: |
            --permission-mode bypassPermissions
            --max-turns 40
          show_full_output: true
          prompt: |
            Resolve every remaining git merge conflict in this working tree (files still
            containing <<<<<<<, =======, >>>>>>> markers). This PR's declared direction is:
            "\${{ github.event.inputs.declared_direction }}" — use it as the tiebreaker when
            intent is ambiguous. Follow this repository's CLAUDE.md conflict-resolution
            guidance. Edit the conflicted files in place, removing all markers. If you cannot
            confidently resolve a conflict, write the reason to a file named
            .quire-unresolved at the repo root instead of guessing.

      # if: always() so a Claude-step failure (e.g. hitting --max-turns) still gets an accurate
      # reason reported back to Quire instead of the generic fallback message in the report
      # step below — and so a lucky finish on the very last turn still gets picked up and
      # committed rather than discarded.
      - name: Verify no conflict markers remain
        id: verify
        if: always()
        run: |
          if [ -f .quire-unresolved ]; then
            echo "resolved=false" >> "$GITHUB_OUTPUT"
            echo "reason=$(cat .quire-unresolved)" >> "$GITHUB_OUTPUT"
          elif git grep -lE '^(<{7}( .*)?|={7}|>{7}( .*)?)$' -- . > /dev/null 2>&1; then
            echo "resolved=false" >> "$GITHUB_OUTPUT"
            echo "reason=resolved content still contained conflict markers" >> "$GITHUB_OUTPUT"
          else
            echo "resolved=true" >> "$GITHUB_OUTPUT"
          fi

      - name: Commit and push
        if: steps.verify.outputs.resolved == 'true'
        run: |
          git add -A
          git commit -m "Resolve merge conflict via Quire conflict-resolution Action"
          git push origin "HEAD:\${{ github.event.inputs.head_branch }}"

      - name: Report outcome back to Quire
        if: always()
        run: |
          if [ "\${{ steps.verify.outputs.resolved }}" = "true" ]; then
            body='{"outcome":"resolved"}'
          else
            reason=\${REASON:-"conflict-resolution workflow failed before verification completed"}
            body=$(printf '{"outcome":"unresolved","reason":%s}' "$(printf '%s' "$reason" | jq -Rs .)")
          fi
          curl -sf -X POST "\${{ github.event.inputs.callback_url }}" \\
            -H "content-type: application/json" \\
            -H "x-quire-callback-token: \${{ github.event.inputs.callback_token }}" \\
            -d "$body"
        env:
          REASON: \${{ steps.verify.outputs.reason }}
`;

const CLAUDE_MD_CONFLICT_RESOLUTION_SECTION = `## Quire conflict-resolution guidance

When resolving a merge conflict in this repository (via Quire's conflict-resolution Action):

- Prefer the more recently-authored intent when two changes are genuinely incompatible —
  favor the incoming PR's change over stale \`main\` content, unless main's change is clearly a
  bugfix the PR predates.
- When both sides changed non-overlapping regions of the same file, preserve both changes —
  never silently drop either side's edit.
- Never leave \`<<<<<<<\`, \`=======\`, or \`>>>>>>>\` conflict markers in the final file content.
- Use the PR's declared direction (given as context) as the tiebreaker when intent is
  ambiguous — resolve in whichever way keeps that direction intact.
- If you cannot confidently resolve a conflict without risking incorrect behavior, say so
  explicitly rather than committing a plausible-looking but wrong resolution.
- Run any available build/lint/test step after resolving, if the repo has one, before
  finishing.
`;

const SETUP_PR_TITLE = "Set up Quire's declared-direction PR convention";

const SETUP_PR_BODY = `<!-- declared-direction: Document and enforce the declared-direction PR convention Quire needs to ingest this repo's PRs -->

Quire ingests PRs by reading a \`<!-- declared-direction: ... -->\` marker from the PR body — PRs missing it are silently skipped from the triage queue. This PR:

- Adds a "Declared direction" section to the PR template so contributors know to include the marker.
- Adds a CI check (\`${WORKFLOW_PATH}\`) that fails a PR missing the marker.
- Adds a conflict-resolution workflow (\`${CONFLICT_RESOLUTION_WORKFLOW_PATH}\`) that Quire dispatches when a bundled PR has a merge conflict it can't resolve on its own.
- Adds (or extends) \`${CLAUDE_MD_PATH}\` with guidance for that workflow's conflict resolution.

**Manual step required:** the conflict-resolution workflow needs an \`ANTHROPIC_API_KEY\` repository secret (Settings → Secrets and variables → Actions) to run. Quire cannot provision this for you — until it's added, conflicts will report back as unresolved with that reason.
`;

export type RepoSetupResult =
	| { status: "already-set-up" }
	| { status: "pr-open"; prNumber: number; prUrl: string }
	| { status: "created"; prNumber: number; prUrl: string };

function buildTemplateContent(existing: string | undefined): string {
	if (existing === undefined) return DECLARED_DIRECTION_SECTION;
	return `${DECLARED_DIRECTION_SECTION}\n${existing}`;
}

function buildClaudeMdContent(existing: string | undefined): string {
	if (existing === undefined) return CLAUDE_MD_CONFLICT_RESOLUTION_SECTION;
	return `${existing}\n${CLAUDE_MD_CONFLICT_RESOLUTION_SECTION}`;
}

export async function setUpDeclaredDirectionConvention(
	client: GitHubClient,
	owner: string,
	name: string,
): Promise<RepoSetupResult> {
	const [template, workflow, conflictWorkflow, claudeMd] = await Promise.all([
		client.getFileContent(owner, name, PR_TEMPLATE_PATH),
		client.getFileContent(owner, name, WORKFLOW_PATH),
		client.getFileContent(owner, name, CONFLICT_RESOLUTION_WORKFLOW_PATH),
		client.getFileContent(owner, name, CLAUDE_MD_PATH),
	]);

	// The PR template and CLAUDE.md are user-owned files Quire only appends a section to, so
	// conformance there just checks the section is present. The two workflow files are wholly
	// generated and owned by Quire, so a stale copy (an older template version, from before a
	// fix like the id-token or allowed_bots ones) needs to be treated as non-conforming and
	// re-pushed — otherwise re-running setup after a Quire upgrade can never repair them.
	const templateConforms = template !== undefined && template.content.includes(DECLARED_DIRECTION_SUBSTRING);
	const workflowConforms = workflow !== undefined && workflow.content === WORKFLOW_CONTENT;
	const conflictWorkflowConforms = conflictWorkflow !== undefined && conflictWorkflow.content === CONFLICT_RESOLUTION_WORKFLOW_CONTENT;
	const claudeMdConforms = claudeMd !== undefined && claudeMd.content.includes(CONFLICT_RESOLUTION_SUBSTRING);

	if (templateConforms && workflowConforms && conflictWorkflowConforms && claudeMdConforms) {
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
	if (!conflictWorkflowConforms) {
		await client.commitFileToBranch(
			owner,
			name,
			SETUP_BRANCH,
			CONFLICT_RESOLUTION_WORKFLOW_PATH,
			CONFLICT_RESOLUTION_WORKFLOW_CONTENT,
			"Add Quire's conflict-resolution workflow",
		);
	}
	if (!claudeMdConforms) {
		await client.commitFileToBranch(
			owner,
			name,
			SETUP_BRANCH,
			CLAUDE_MD_PATH,
			buildClaudeMdContent(claudeMd?.content),
			"Add Quire's conflict-resolution guidance to CLAUDE.md",
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
