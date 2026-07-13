import type { GitHubClient, RepoFile } from "./client.js";

const PR_TEMPLATE_PATH = ".github/pull_request_template.md";
const WORKFLOW_PATH = ".github/workflows/quire-declared-direction.yml";
const CLAUDE_MD_PATH = "CLAUDE.md";
const CLAUDE_SETTINGS_PATH = ".claude/settings.json";
const CLAUDE_HOOK_SCRIPT_PATH = ".claude/hooks/check-declared-direction.sh";
const GIT_HOOK_PATH = ".githooks/pre-push";
const SETUP_BRANCH = "quire/setup-declared-direction";
const DECLARED_DIRECTION_SUBSTRING = "declared-direction";

const DECLARED_DIRECTION_SECTION = `## Declared direction

<!-- declared-direction: one-sentence summary of this PR's product-direction intent -->

Quire ingests PRs by reading the \`declared-direction\` marker above. PRs missing it still reach the triage queue, but each lands in its own bundle instead of being grouped with related work.
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
            echo "::error::PR body is missing a <!-- declared-direction: ... --> marker. Quire will still triage this PR, but on its own instead of grouped with related work."
            exit 1
          fi
`;

const CLAUDE_MD_SECTION = `## Declared direction

Quire (the PR-triage tool this repo is dogfooded/reviewed through) reads a \`<!-- declared-direction: ... -->\` marker from each PR body to group related PRs into one bundle. When opening a PR here — by hand or as a coding agent — include the marker, e.g.:

\`\`\`
<!-- declared-direction: Add dark mode toggle to settings panel -->
\`\`\`

A PR missing it still gets triaged, just on its own instead of grouped with related work. This repo also ships a Claude Code hook (\`${CLAUDE_SETTINGS_PATH}\`) that blocks \`gh pr create\`/\`gh pr edit\` commands missing the marker, and a local git pre-push reminder (\`${GIT_HOOK_PATH}\`) — run \`git config core.hooksPath .githooks\` once after cloning to enable the latter.
`;

// Exported so tests can seed a repo whose committed copy already matches.
export const CLAUDE_HOOK_SCRIPT_CONTENT = `#!/usr/bin/env bash
# Blocks "gh pr create"/"gh pr edit" commands whose body is missing Quire's
# <!-- declared-direction: ... --> marker. Installed by Quire's repo setup — see CLAUDE.md.
set -euo pipefail

input="$(cat)"
command="$(printf '%s' "$input" | grep -o '"command"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n1 || true)"

if ! printf '%s' "$command" | grep -qE 'gh pr (create|edit)'; then
  exit 0
fi

if printf '%s' "$command" | grep -qP '<!--\\s*declared-direction:\\s*\\S.*-->'; then
  exit 0
fi

echo "This PR body is missing a <!-- declared-direction: ... --> marker. Add one describing this PR's product-direction intent before opening/editing the PR." >&2
exit 2
`;

const CLAUDE_HOOK_COMMAND = `bash ${CLAUDE_HOOK_SCRIPT_PATH}`;

const CLAUDE_HOOK_ENTRY = {
	matcher: "Bash",
	hooks: [{ type: "command", command: CLAUDE_HOOK_COMMAND }],
};

// The exact content committed for a repo whose .claude/settings.json didn't exist yet —
// exported so tests can seed a repo whose committed copy already matches.
export const CLAUDE_SETTINGS_CONTENT = `${JSON.stringify({ hooks: { PreToolUse: [CLAUDE_HOOK_ENTRY] } }, null, "\t")}\n`;

// Exported so tests can seed a repo whose committed copy already matches.
export const GIT_HOOK_CONTENT = `#!/usr/bin/env sh
# Local reminder only — git hooks can't see PR body content, so this can't verify the
# declared-direction marker itself. Installed by Quire's repo setup — see CLAUDE.md.
echo "Reminder: if this push opens or updates a PR, its body needs a <!-- declared-direction: ... --> marker for Quire." >&2
exit 0
`;

const SETUP_PR_TITLE = "Set up Quire's declared-direction PR convention";

const SETUP_PR_BODY = `<!-- declared-direction: Document and enforce the declared-direction PR convention Quire needs to ingest this repo's PRs -->

Quire ingests PRs by reading a \`<!-- declared-direction: ... -->\` marker from the PR body — PRs missing it still reach the triage queue, but each lands in its own bundle instead of being grouped with related work. This PR:

- Adds a "Declared direction" section to the PR template so contributors know to include the marker.
- Adds a CI check (\`${WORKFLOW_PATH}\`) that fails a PR missing the marker.
- Documents the convention in \`${CLAUDE_MD_PATH}\` for human and coding-agent contributors.
- Adds a Claude Code hook (\`${CLAUDE_SETTINGS_PATH}\` + \`${CLAUDE_HOOK_SCRIPT_PATH}\`) that blocks \`gh pr create\`/\`gh pr edit\` commands missing the marker, so agent-authored PRs carry it by construction.
- Adds a local git pre-push reminder (\`${GIT_HOOK_PATH}\`) — run \`git config core.hooksPath .githooks\` once after cloning to enable it.
`;

export type RepoSetupResult =
	| { status: "already-set-up" }
	| { status: "pr-open"; prNumber: number; prUrl: string }
	| { status: "created"; prNumber: number; prUrl: string };

interface SetupItem {
	path: string;
	commitMessage: string;
	// Given the existing file (undefined if absent), returns the content to commit and
	// whether the existing content already conforms (so unchanged items aren't re-committed).
	resolve(existing: RepoFile | undefined): { content: string; conforms: boolean };
}

function appendSectionResolver(section: string): SetupItem["resolve"] {
	return (existing) => {
		if (existing === undefined) return { content: section, conforms: false };
		if (existing.content.includes(DECLARED_DIRECTION_SUBSTRING)) {
			return { content: existing.content, conforms: true };
		}
		return { content: `${section}\n${existing.content}`, conforms: false };
	};
}

function exactMatchResolver(content: string): SetupItem["resolve"] {
	return (existing) => ({ content, conforms: existing !== undefined && existing.content === content });
}

// settings.json is very plausibly user-owned (unlike the wholly Quire-generated workflow
// file), so it can't be exact-match-replaced. This splices our hook entry into whatever
// hooks/settings already exist, leaving the rest of the file untouched, and treats "our
// entry is already present" as conforming independent of any other content in the file.
function claudeSettingsResolver(): SetupItem["resolve"] {
	return (existing) => {
		let parsed: Record<string, unknown>;
		try {
			parsed = existing === undefined ? {} : (JSON.parse(existing.content) as Record<string, unknown>);
		} catch {
			parsed = {};
		}

		const hooks = (parsed.hooks as Record<string, unknown> | undefined) ?? {};
		const preToolUse = Array.isArray(hooks.PreToolUse) ? (hooks.PreToolUse as Array<Record<string, unknown>>) : [];

		const alreadyPresent = preToolUse.some(
			(entry) =>
				Array.isArray(entry.hooks) &&
				(entry.hooks as Array<Record<string, unknown>>).some((h) => h.command === CLAUDE_HOOK_COMMAND),
		);

		if (alreadyPresent) {
			return { content: existing?.content ?? `${JSON.stringify(parsed, null, "\t")}\n`, conforms: true };
		}

		const merged = {
			...parsed,
			hooks: { ...hooks, PreToolUse: [...preToolUse, CLAUDE_HOOK_ENTRY] },
		};
		return { content: `${JSON.stringify(merged, null, "\t")}\n`, conforms: false };
	};
}

const SETUP_ITEMS: ReadonlyArray<SetupItem> = [
	{
		path: PR_TEMPLATE_PATH,
		commitMessage: "Document the declared-direction PR convention",
		resolve: appendSectionResolver(DECLARED_DIRECTION_SECTION),
	},
	{
		path: WORKFLOW_PATH,
		commitMessage: "Add CI check for the declared-direction PR convention",
		resolve: exactMatchResolver(WORKFLOW_CONTENT),
	},
	{
		path: CLAUDE_MD_PATH,
		commitMessage: "Document the declared-direction PR convention in CLAUDE.md",
		resolve: appendSectionResolver(CLAUDE_MD_SECTION),
	},
	{
		path: CLAUDE_HOOK_SCRIPT_PATH,
		commitMessage: "Add a Claude Code hook enforcing the declared-direction PR convention",
		resolve: exactMatchResolver(CLAUDE_HOOK_SCRIPT_CONTENT),
	},
	{
		path: CLAUDE_SETTINGS_PATH,
		commitMessage: "Wire the declared-direction hook into .claude/settings.json",
		resolve: claudeSettingsResolver(),
	},
	{
		path: GIT_HOOK_PATH,
		commitMessage: "Add a local git pre-push reminder for the declared-direction PR convention",
		resolve: exactMatchResolver(GIT_HOOK_CONTENT),
	},
];

interface ResolvedItem {
	item: SetupItem;
	content: string;
	conforms: boolean;
}

async function resolveItems(client: GitHubClient, owner: string, name: string): Promise<ReadonlyArray<ResolvedItem>> {
	return Promise.all(
		SETUP_ITEMS.map(async (item) => {
			const existing = await client.getFileContent(owner, name, item.path);
			const { content, conforms } = item.resolve(existing);
			return { item, content, conforms };
		}),
	);
}

// Read-only: lets a caller check whether a repo needs the setup PR before committing to
// opening one, e.g. to skip a confirmation prompt when there's nothing to do.
export async function checkDeclaredDirectionConvention(client: GitHubClient, owner: string, name: string): Promise<boolean> {
	const resolved = await resolveItems(client, owner, name);
	return resolved.every((r) => r.conforms);
}

export async function setUpDeclaredDirectionConvention(
	client: GitHubClient,
	owner: string,
	name: string,
): Promise<RepoSetupResult> {
	const resolved = await resolveItems(client, owner, name);

	if (resolved.every((r) => r.conforms)) {
		return { status: "already-set-up" };
	}

	const defaultBranch = await client.getDefaultBranch(owner, name);

	for (const { item, content, conforms } of resolved) {
		if (conforms) continue;
		await client.commitFileToBranch(owner, name, SETUP_BRANCH, item.path, content, item.commitMessage);
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
