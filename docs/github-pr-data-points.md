# GitHub PR data: what's available, what we proposed, what we built

This doc is the record of a scoping pass over GitHub's PR data model — what
the API exposes, which of it maps to a user-facing gap in Quire, and which
slice actually landed. Kept as a reference so the next data point added to
`RawPRPayload`/`PullRequest` has a paper trail instead of getting re-derived
from scratch.

## What GitHub's API exposes for a PR

A pull request is really two overlapping resources — the `pulls` endpoint
and the underlying `issue` object every PR also is — plus several
sub-resources.

**Core PR fields** (`GET /repos/{owner}/{repo}/pulls/{number}`): id,
node_id, number, url/html_url/diff_url/patch_url, title, body, state,
locked, draft, user (author), created_at/updated_at/closed_at/merged_at,
merged, merged_by, merge_commit_sha, mergeable/mergeable_state/rebaseable,
head/base (ref, sha, repo — including fork info), assignees,
requested_reviewers, requested_teams, labels, milestone,
comments/review_comments/commits/additions/deletions/changed_files
(counts), maintainer_can_modify, auto_merge.

**Files changed** (`.../pulls/{number}/files`): filename, status,
additions, deletions, changes, patch (diff hunk), previous_filename,
blob_url, raw_url, sha.

**Commits** (`.../pulls/{number}/commits`): sha, author/committer, message,
verification/signature status, parents.

**Reviews** (`.../pulls/{number}/reviews`): reviewer, state
(APPROVED/CHANGES_REQUESTED/COMMENTED/DISMISSED/PENDING), body,
submitted_at, commit_id.

**Review comments** (`.../pulls/{number}/comments`): inline code comments —
path, line/position, diff_hunk, body, in_reply_to_id, author, timestamps.

**Issue-side fields** (PRs share the Issues API): labels, assignees,
milestone (canonical source), general conversation comments
(`.../issues/{number}/comments`, separate from review comments), reactions
(👍👎😄🎉😕❤️🚀👀), locked/lock_reason.

**CI/checks**: Checks API (`.../commits/{sha}/check-runs` — name, status,
conclusion, timestamps, output/annotations, app) and the legacy Combined
Status API (`.../commits/{sha}/status` — per-context state, description,
target_url).

**Timeline/events** (`.../issues/{number}/timeline`): labeled/unlabeled,
assigned/unassigned, review_requested, ready_for_review,
converted_to_draft, head_ref_force_pushed, merged, closed, renamed,
cross-referenced, committed.

**Other**: requested reviewers/teams, `mergeable_state` enum, branch
protection status via `.../branches/{branch}/protection`.

## What Quire ingested before this pass

`OctokitGitHubClient.toRawPRPayload` (`src/engine/github/octokitClient.ts`)
only pulled: `id`, `number`, `title`, `body`, `headSha`, `diff`,
`filesTouched` (filenames only — no patches/additions/deletions),
`ciStatus`/`ciChecksSummary`, `declaredDirection`/`directionInferred`
(regex over `body`), `linkedIssueNumber` (regex over `body`). Everything
else in the inventory above — labels, assignees, reviewers, milestone,
reactions, review/issue comments, commit list, per-file
additions/deletions/patch, mergeable state (used only by the separate
conflict-resolution path, not ingestion), timeline events, draft status
(same caveat) — was unused by ingestion.

## Features proposed, and why

Reasoned from what a human triaging a swarm of agent PRs actually wants to
know before gesturing accept/reject/defer:

| Desired feature | Data point(s) | Rationale |
|---|---|---|
| Filter/sort queue by label | `labels[]` | Lets a human narrow the queue instead of scanning every bundle. |
| "Who's on this" visibility | `assignees[]` | Assignment context GitHub already tracks; Quire threw it away. |
| Author reputation / bot-vs-human filter | `user.login`, `user.type` | Cheap prior on trustworthiness of a swarm member. |
| "Someone already reviewed this" warning | `reviews[]`, issue `comments` | Avoids re-litigating a PR a teammate already vetoed — in scope since Quire triages, doesn't re-verify. |
| Reaction-based cheap signal | `reactions` | 👍/👎 as an even cheaper prior than a review. |
| Milestone/roadmap grouping | `milestone` | Ties bundles to a release/roadmap item. |
| Check-level CI detail (not just pass/fail) | `check-runs[].name/conclusion/output` | Currently only an aggregate status + completed/total count; useful for the `buildFailure` gate criterion's audit view. |
| PR age / staleness sort | `created_at`, `updated_at` | Lets stale PRs surface or be deprioritized. |
| Size-at-a-glance beyond blast radius | `additions`, `deletions`, `changed_files` | `filesTouched` names are kept but not the size counts. |
| Linked-issue context beyond the number | Issue title/body/labels | `getIssue` already exists; not surfaced in the review card. |

Prioritization at the time: **labels + assignees + reviews/comments** were
called out as highest-value/lowest-effort (queue filtering, "don't
re-review what a human already vetoed"). CI check-level detail was next.
Reactions/milestones were judged lower priority — nice-to-have, not core to
the accept/reject/defer decision.

## What we actually built

Scope was narrowed to **labels and assignees only** (see PR
[#271](https://github.com/ethanluh/quire/pull/271)) — carry the data
through and display it, nothing more:

- `RawPRPayload` (`src/engine/github/client.ts`) gained
  `labels: ReadonlyArray<string>` and `assignees: ReadonlyArray<string>`.
- `OctokitGitHubClient.toRawPRPayload` maps GitHub's label objects (or bare
  strings, the legacy form) to names, and assignee objects to logins —
  both `pulls.get` and `pulls.list` already return these fields, so no
  extra API call was needed.
- `IncomingPRSchema` (`src/engine/ingest/schema.ts`) and
  `rawPRPayloadToIncomingPR` thread both fields through as optional arrays,
  matching the existing `filesTouched` pattern.
- `normalizePR` (`src/engine/ingest/ingest.ts`) defaults them to `[]` on
  the final `PullRequest` type (`src/engine/types/core.ts`), which now
  documents them as descriptive metadata — never a drift/verdict input,
  same discipline as `declaredDirection` under INV-1.
- `prMemberListHtml` (`src/interface/ui/shared/render.js`, shared by
  `index.html` and `mobile.html`) renders labels and assignees as badges
  next to the existing files-touched-count badge on each bundle member row.

**Deliberately not done** in this pass, and why:
- No `detectFlags` rule reacting to a label (e.g. flagging a
  `security`-labeled PR) — that's a separate directional decision (which
  labels matter, and how) outside the approved scope.
- No `computeInputsHash` change — labels/assignees aren't verdict inputs,
  so a label-only edit shouldn't invalidate a cached review card.
- Labels/assignees kept as flat name/login strings, not richer objects
  (color, description, avatar, id) — nothing today consumes those extra
  fields.
- No queue-level filter/sort UI — this pass only added display badges on
  the bundle-detail member rows.
- Reviews, issue/PR comments, reactions, milestone, CI check-level detail,
  PR age, and additions/deletions counts remain unimplemented — all listed
  above as candidate follow-ups, none in scope for this change.
