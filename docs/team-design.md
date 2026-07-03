# Team feature: how it actually works

Quire used to be a single-operator tool: every signed-in GitHub login got its
own fully isolated `TenantContext` (queue, decisions, GitHub App
installation, LLM key, settings). [PR #148](https://github.com/ethanluh/quire/pull/148)
replaced that with a team model — this doc describes what actually shipped,
not an aspirational design. Where the shipped behavior differs from what was
originally proposed, that's called out explicitly in "Known gaps" below
rather than glossed over.

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

**A team still has exactly one repo, one installation set, one queue** —
this did *not* become a multi-repo-per-team model. `InstallationAccountState`
(`installations[]`, `selectedRepo`, `autoMergeOnAccept`,
`flagConflictsForFleet`) moved from `data/users/<login>/installation.json` to
`data/teams/<teamId>/installation.json` verbatim, unchanged in shape. If a
team wants to work a second repo, that's not supported today — see "Known
gaps."

### Disk layout

```
data/teams/<teamId>/
  team.json                  # { teamId, name, createdAt, createdBy }
  members.json               # TeamMembership[] — { login, teamId, role, joinedAt }
  installation.json          # InstallationAccountState — unchanged shape, just team-scoped now
  llm-account.json           # ConnectedLlmAccount — one shared key per team
  queue.json
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
pointer. Idempotent — safe to run on every boot.

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

## Invites: signed links, not invite-by-login rows

Also a departure from the original proposal (which specified inviting a
teammate by typing their GitHub login before they'd ever signed in). What
shipped:

- `POST /team/invite` (owner/admin only) mints a signed, expiring token
  (`src/interface/server/invite.ts`, `signedToken.ts` — same
  base64url-JSON + HMAC-SHA256 shape as session cookies, 7-day TTL) and
  returns a URL: `<publicUrl>/?joinTeam=<token>`.
- The inviter shares that URL out-of-band (Slack, etc.) — there's no
  invite-by-login roster entry, no "pending" row visible before someone
  actually redeems the link.
- `POST /team/join { token }` verifies the token, and if the caller isn't
  already a member, adds them with a **fixed role of `member`** — the
  inviter cannot pre-select `admin` at invite time. Promoting someone
  after they join is a separate step (`POST /team/members/:login/role`).
- Redeeming a join updates the joining login's `membership.json` to add the
  new `teamId` to `teamIds` and set it as `activeTeamId`.

This is a smaller, more GitHub-Gist-link-like mechanism than the
originally-proposed roster-based invite, and it sidesteps needing to
validate/case-fold a typed GitHub login against a real account before
that account has ever signed in. The tradeoff: there's no way to see "who
have I invited that hasn't joined yet" the way a persisted `status: "invited"`
row would have given you — an unredeemed link is just a token nobody's
used, invisible to the roster view.

Session secret persistence (`sessionSecret.ts`) is a direct consequence of
invite links being signed with the same secret as session cookies: the
secret is now generated once and written to disk (`QUIRE_SESSION_SECRET`
env var still overrides it) rather than re-randomized on every process
restart, so an outstanding invite link surviving a deploy doesn't
mysteriously start failing signature verification.

## Roles and the actual permission matrix

Three roles: `owner`, `admin`, `member`. Verified directly against every
`requireRole(...)` call site in the shipped code:

| Action | Owner | Admin | Member |
|---|:---:|:---:|:---:|
| Rename team (`PATCH /team`) | Y | Y | N |
| Invite a member (`POST /team/invite`) | Y | Y | N |
| Change a member's role (`POST /team/members/:login/role`) | Y | Y | N |
| Remove a member (`POST /team/members/:login/remove`) | Y | Y | N |
| Change team settings — `autoMergeOnAccept`/`flagConflictsForFleet` (`POST /account/github/settings`) | Y | N | N |
| Process/land the queue (`POST /queue/process`) | Y | N | N |
| Retry a conflicted bundle (`POST /queue/:bundleId/retry`) | Y | N | N |
| Abort a stuck bundle (`POST /queue/:bundleId/abort`) | Y | N | N |
| Revert a merged PR (`DELETE /queue/:bundleId/prs/:prId`) | Y | N | N |
| Remove a queued bundle (`DELETE /queue/:bundleId`) | Y | N | N |
| Admin reset (`POST /admin/reset`) | Y | N | N |
| Create/join/leave a team, switch active team | Y | Y | Y |
| View queue, roster, audit log | Y | Y | Y |
| **Gesture (accept/defer/reject) on any bundle** | Y | Y | **Y — unrestricted** |

Two things worth flagging explicitly:

1. **Admin is *not* "almost owner" the way originally proposed** — admin can
   manage membership and roles (same as owner, short of removing/demoting
   the owner) but cannot touch merge-queue operations or team settings at
   all; those are owner-only, full stop. This is a stricter split than
   "admin ≈ owner on everything operational" — merge-queue mutations and
   settings are owner-exclusive, membership management is owner-**and**-admin.
2. **`autoMergeOnAccept` is the actual authorization lever for automatic
   merging, and it's owner-gated.** Turning it on is itself an owner-only
   action; once on, *any* member's `accept` gesture drains the queue exactly
   the same as an owner's would. The reasoning, taken from the code comment
   in `gestures.ts`: flipping that setting on is the authorization decision
   for every accept that follows, deliberately independent of who performs
   the accept afterward.

## Known gaps vs. the original proposal

These are real, current limitations — not roadmap items being tracked
elsewhere yet:

- **No per-bundle or per-PR assignment.** The original ask was "reviews can
  be assigned, and only users to whom PRs have been assigned can accept."
  Nothing shipped here: there's no `assignedTo` field anywhere in the
  codebase, and `POST /bundles/:bundleId/gesture` has no assignment check at
  all — **any team member can accept, defer, or reject any bundle**,
  unrestricted. The only distinction the shipped code draws is role-based
  (owner vs. everyone else) and only for queue-*processing* operations, not
  for the accept/defer/reject gesture itself. If per-reviewer assignment is
  still wanted, it hasn't been built.
- **One repo per team, not several.** A team cannot watch multiple repos
  concurrently, and `autoMergeOnAccept`/`flagConflictsForFleet` are
  necessarily team-wide rather than per-repo, since there's only one repo to
  apply them to.
- **No role selection at invite time.** Everyone who joins via an invite
  link becomes a `member`; an owner/admin must promote them separately.
- **No per-member LLM cost/usage attribution.** One shared team-wide LLM key,
  as originally proposed, with no usage tracking per member.
- **No "who's been invited but hasn't joined" visibility.** Signed links
  aren't persisted anywhere queryable — the roster only shows people who
  have actually redeemed a link.

## Test coverage

`teamStore.test.ts`, `teamRouter.test.ts`, `resolveMembership.test.ts`,
`requireRole.test.ts`, `invite.test.ts`, `signedToken.test.ts`,
`sessionSecret.test.ts`, and `migrateLegacyData.test.ts` cover this slice;
`tenant.test.ts` was extended to assert the "two different logins, same
team, same `TenantContext`" invariant that didn't previously have coverage
because the concept didn't exist.
