# Team feature: how it actually works

Quire used to be a single-operator tool: every signed-in GitHub login got its
own fully isolated `TenantContext` (queue, decisions, GitHub App
installation, LLM key, settings). [PR #148](https://github.com/ethanluh/quire/pull/148)
replaced that with a team model — this doc describes what actually shipped,
not an aspirational design. Where the shipped behavior differs from what was
originally proposed, that's called out explicitly in "Known gaps" below
rather than glossed over. A first pass of this doc (immediately after #148)
listed five gaps against the original proposal; four have since been closed
by follow-up PRs (#154, #156, #157, #161) and are folded into the sections
below instead of staying in the gap list.

## Architecture: team replaces login as the tenant key

`TenantRegistry` is keyed by `teamId`, not `login`. A `TenantContext` still
holds exactly what it always held (`MergeQueue`, `DecidedPrStore`,
`ServerState`, `AuditStore`, `AccountState`, `LlmAccountState`, a per-tenant
router) — the only structural change is that several human logins can now
resolve to the same one.

Every request goes through `requireSession` (verifies the login) then
`resolveMembership` (looks up that login's *active* team) then
`resolveTenant` (loads the `TenantContext` for that team). `resolveMembership`
auto-provisions a personal team-of-one on a login's very first request, so
no route ever has to handle a "this user has no team" state.

### A team can watch several repos, each with its own settings

Originally a team had exactly one repo, one installation set, one queue
([PR #161](https://github.com/ethanluh/quire/pull/161) closed this gap).
`InstallationAccountState` (`installations[]`, `repos[]`) still lives at
`data/teams/<teamId>/installation.json`, but `repos[]` replaces the old
singular `selectedRepo?` — each `RepoBinding` carries its own
`autoMergeOnAccept`/`flagConflictsForFleet`/`enableDeepConflictInvestigation`
(a team can want auto-merge on for a low-stakes repo and off for a critical
one), plus `addedAt`/`addedBy` for audit.

`MergeQueue`/`DecidedPrStore`/`ServerState`/`AuditStore`/`PrEffectCache` stay
**one shared instance per team**, not one per repo — a bundle's members
already carry their own `repoOwner`/`repoName`, so nothing about holding
several repos' PRs in one set of maps needed to change. What *did* need to
become repo-aware: a new `MultiRepoGitHubClient` (held by the existing
`GitHubClientHolder`) resolves the right per-installation API client live, on
every call, off `accountState.current.repos` — every `GitHubClient` method
already took `owner`/`repo` as its first two arguments, so this one
dispatching layer made the entire existing single-client call graph
(`MergeQueue`, `gesturesRouter`, ingestion) multi-repo-correct without
changing any of those call sites. Selecting or disconnecting a repo no longer
needs to repoint a shared client at all, which also simplified those routes.

`POST /repos/select` is additive now (409 if the repo's already watched,
instead of replacing a single slot); `DELETE /repos/:owner/:name` removes one
without touching the others; the old team-wide `POST /settings` became
`POST /repos/:owner/:name/settings` (still owner-only). Disconnecting an
installation orphans (and tears down the queue for) every repo bound through
it, not just a single "active" one.

### Disk layout

```
data/teams/<teamId>/
  team.json                  # { teamId, name, createdAt, createdBy }
  members.json               # TeamMember[] — { login, teamId, role, status, invitedBy, invitedAt, joinedAt? }
  invites.json               # InviteRecord[] — { id, invitedBy, issuedAt, expiresAt, redeemedBy?, redeemedAt?, revokedAt? }
  installation.json          # InstallationAccountState — installations[] + repos[] (each RepoBinding carries its own settings)
  llm-account.json           # ConnectedLlmAccount — one shared key per team
  queue.json                 # shared across every repo the team watches
  decided-prs.json
  pr-cache.json
  instrumentation/*.ndjson

data/users/<login>/
  github-user-token.json     # OAuth refresh token — stays per-human, never team-shared
  membership.json            # LoginMembershipIndex: { teamIds: string[], activeTeamId: string }
```

`teamId` is an opaque random id (`randomBytes(12).toString("hex")`,
`teamStore.ts`), never derived from a login — including for a login's
implicit personal team. This was a deliberate departure from keying personal
teams deterministically off the login: it means every team, personal or
shared, is created through the exact same code path with no special case,
at the cost of needing the `membership.json` reverse-index file to ever find
a login's team again (a deterministic id wouldn't have needed one for the
personal-team case, but would still have needed it the moment
multi-team-per-login existed anyway — see below).

### Migration

`migrateLegacyData` (`src/interface/server/migrateLegacyData.ts`) runs once
at startup: for every `data/users/<login>/` directory that predates the team
feature, it creates a personal team, moves `installation.json`/
`llm-account.json`/`queue.json`/`decided-prs.json`/`pr-cache.json`/
`instrumentation/*` into it, and writes the login's `membership.json`
pointer. Idempotent — safe to run on every boot. There is no equivalent
migration for the later `selectedRepo` → `repos[]` reshape — consistent with
this codebase's existing "no migration from the old single-binding shape"
precedent (`installation.ts`), an old-format `installation.json` simply fails
the type guard and loads as no installations; a team re-adds its repo once
after that deploy.

## Membership: a login can belong to several teams, with one active at a time

This is the biggest departure from the original proposal, which explicitly
deferred multi-team membership to a later phase. What shipped instead:

```ts
interface LoginMembershipIndex {
  teamIds: ReadonlyArray<string>;
  activeTeamId: string;
}
```

A login can be a member of multiple teams (its own personal team plus any
it's joined) and explicitly switches which one is "active" via
`POST /team/switch`. Whichever team is active is the one `resolveTenant`
loads for every subsequent request — there's no split-screen or per-request
team selection, just a single active context you switch in and out of, the
same way a GitHub CLI `gh auth switch` or a cloud CLI's active-project
context works.

Reasoning (inferred from the implementation, not a decision record written
at the time): a deterministic personal-team id and a "you can only ever be
in one team" constraint would have avoided needing this reverse-index file
and switch endpoint entirely — but the moment invite links exist, a login
that already has a personal team needs *some* way to end up on a second
team without destroying the first, and "add it to your list, pick which one
is active" is a smaller, more general mechanism than "retire your personal
team and hope you never want it back."

## Invites: signed links, tracked as records, with a selectable role

Originally a departure from the original proposal (which specified inviting
a teammate by typing their GitHub login before they'd ever signed in, with a
role chosen at invite time and a visible "pending" roster row). What shipped,
after [PR #156](https://github.com/ethanluh/quire/pull/156) and
[PR #157](https://github.com/ethanluh/quire/pull/157) closed two of the
original gaps here:

- `POST /team/invite` (owner/admin only) accepts an optional
  `{ role: "admin" | "member" }` (defaults to `"member"`; `"owner"` is
  rejected — top-level custody is always a separate, explicit transfer) and
  mints a signed, expiring token (`src/interface/server/invite.ts`,
  `signedToken.ts` — same base64url-JSON + HMAC-SHA256 shape as session
  cookies, 7-day TTL) carrying that role plus a fresh `id`. Returns a URL:
  `<publicUrl>/?joinTeam=<token>`.
- The invite is also persisted as an `InviteRecord` in the team's
  `invites.json`, correlated to the token by that `id`. `GET /team/invites`
  (owner/admin) lists every invite ever minted with a derived status —
  `pending`, `redeemed`, `revoked`, or `expired` — closing the original
  "who have I invited that hasn't joined yet" gap.
- `DELETE /team/invites/:id` (owner/admin) revokes a still-pending invite;
  `POST /team/join` checks this before honoring an otherwise-still-valid
  token, so a revoked link stops working without needing to rotate the
  shared session secret every other signed link relies on.
- `POST /team/join { token }` verifies the token, applies its role if the
  caller isn't already a member, marks the matching `InviteRecord` redeemed,
  and updates the joining login's `membership.json` to add the new `teamId`
  to `teamIds` and set it as `activeTeamId`.

This is still a smaller, more GitHub-Gist-link-like mechanism than the
originally-proposed roster-based invite (there's no way to invite a login
that has no way to receive the link out-of-band), but the persisted
`InviteRecord` closes the practical gap that mechanism left: an owner/admin
can now see and manage outstanding invites without waiting for someone to
redeem one.

Session secret persistence (`sessionSecret.ts`) is a direct consequence of
invite links being signed with the same secret as session cookies: the
secret is now generated once and written to disk (`QUIRE_SESSION_SECRET`
env var still overrides it) rather than re-randomized on every process
restart, so an outstanding invite link surviving a deploy doesn't
mysteriously start failing signature verification.

## Assignment and gesture gating

Also closed since the first pass of this doc
([PR #154](https://github.com/ethanluh/quire/pull/154)): bundles can now be
assigned, and an assignment gates who may gesture on one.

- `Bundle` gained `assignedTo`/`assignedAt`/`assignedBy` — bundle-level only
  (no per-PR assignee field), matching this tool's central premise of one
  directional decision per bundle.
- Gesturing on an unassigned bundle (or one already assigned to you)
  self-assigns it as part of the same request — there's no separate "claim"
  step required before acting.
- Gesturing on a bundle assigned to someone else: 403 for a plain member,
  409 for an owner/admin (retry with `?force=true` to override — the
  primary UI affordance is "reassign to me" rather than force, which exists
  as an emergency escape hatch).
- `POST /bundles/:id/assign` / `DELETE /bundles/:id/assign` allow explicit
  hand-routing outside of gesturing — self-assign is always allowed;
  assigning to or unassigning someone else requires owner/admin.
- `DecidedPrEntry` (the audit trail) gained `decidedBy`, `bundleId`,
  `wasAssignedTo`, and `overrodeAssignment`, so a force-override is visible
  after the fact.

## Roles and the actual permission matrix

Three roles: `owner`, `admin`, `member`. Verified directly against every
`requireRole(...)` call site (and the inline checks in `gestures.ts`/
`assignments.ts`) in the shipped code:

| Action | Owner | Admin | Member |
|---|:---:|:---:|:---:|
| Rename team (`PATCH /team`) | Y | Y | N |
| Invite a member, any role up to admin (`POST /team/invite`) | Y | Y | N |
| View pending/redeemed invites (`GET /team/invites`) | Y | Y | N |
| Revoke a pending invite (`DELETE /team/invites/:id`) | Y | Y | N |
| Change a member's role (`POST /team/members/:login/role`) | Y | Y | N |
| Remove a member (`POST /team/members/:login/remove`) | Y | Y | N |
| Add a repo to the team's watch list (`POST /account/github/repos/select`) | Y | Y | Y (unrestricted) |
| Remove a watched repo (`DELETE /account/github/repos/:owner/:name`) | Y | Y | N |
| Change a repo's settings — `autoMergeOnAccept`/`flagConflictsForFleet`/`enableDeepConflictInvestigation` (`POST /account/github/repos/:owner/:name/settings`) | Y | N | N |
| Process/land the queue (`POST /queue/process`) | Y | N | N |
| Retry a conflicted bundle (`POST /queue/:bundleId/retry`) | Y | N | N |
| Abort a stuck bundle (`POST /queue/:bundleId/abort`) | Y | N | N |
| Revert a merged PR (`DELETE /queue/:bundleId/prs/:prId`) | Y | N | N |
| Remove a queued bundle (`DELETE /queue/:bundleId`) | Y | N | N |
| Admin reset (`POST /admin/reset`) | Y | N | N |
| Create/join/leave a team, switch active team | Y | Y | Y |
| View queue, roster, audit log | Y | Y | Y |
| Assign a bundle to self, or unassign own | Y | Y | Y |
| Assign/reassign a bundle to someone else, or unassign theirs | Y | Y | N |
| Gesture on an unassigned bundle, or one assigned to me | Y | Y | Y |
| Gesture on a bundle assigned to someone else | Y (`force=true`) | Y (`force=true`) | N |

Two things worth flagging explicitly:

1. **Admin is *not* "almost owner" the way originally proposed** — admin can
   manage membership, roles, and invites (same as owner, short of
   removing/demoting the owner) and can add/remove watched repos, but cannot
   touch merge-queue operations or a repo's settings at all; those are
   owner-only, full stop. This is a stricter split than "admin ≈ owner on
   everything operational" — merge-queue mutations and repo settings are
   owner-exclusive, membership/invite/repo-roster management is
   owner-**and**-admin.
2. **`autoMergeOnAccept` is the actual authorization lever for automatic
   merging, and it's owner-gated, per repo.** Turning it on for a given repo
   is itself an owner-only action; once on, *any* member's `accept` gesture
   on that repo's bundles drains the queue exactly the same as an owner's
   would. The reasoning, taken from the code comment in `gestures.ts`:
   flipping that setting on is the authorization decision for every accept
   that follows, deliberately independent of who performs the accept
   afterward.

## Known gaps vs. the original proposal

Real, current limitations — not roadmap items being tracked elsewhere yet:

- **No per-member LLM cost/usage attribution.** One shared team-wide LLM key,
  as originally proposed, with no usage tracking per member. This is not a
  broken promise — the original proposal itself deferred this explicitly,
  since it needs new instrumentation infrastructure this codebase doesn't
  have yet (today's NDJSON instrumentation covers gate decisions, drift
  screens, defers, conflict resolutions — no token/spend fields anywhere).
  When built, it should extend that existing audit-log surface rather than
  add a parallel accounting subsystem.

## Test coverage

`teamStore.test.ts`, `teamRouter.test.ts`, `resolveMembership.test.ts`,
`requireRole.test.ts`, `invite.test.ts`, `signedToken.test.ts`,
`sessionSecret.test.ts`, `migrateLegacyData.test.ts`, and
`accountState.test.ts`'s `installationForRepo`/`repoBinding` cases cover this
slice; `tenant.test.ts` was extended to assert the "two different logins,
same team, same `TenantContext`" invariant that didn't previously have
coverage because the concept didn't exist, and `gestures.test.ts`/
`githubAppRouter.test.ts` were substantially extended — the former gained an
`assignmentsRouter` describe block covering assignment/gesture gating, the
latter was rewritten for multi-repo add/remove/settings/disconnect behavior.
