# Merge-Conflict Resolver — Engineering Handoff

Owner-of-record's mental model, written down so it survives them leaving. Companion to
[`engineering-handoff.md`](engineering-handoff.md) (the whole-product build spec) — this doc
covers one subsystem in depth: what happens when a bundled PR in the merge queue can't be
merged cleanly.

If you're inheriting this system cold, read §1 for what it does, §2 for why it looks the way
it does (skip this at your peril — two earlier designs were tried and abandoned, and someone
will eventually propose re-trying one of them), §3 when something breaks, §4 for what's
genuinely unfinished.

---

## 1. What it does

Entry point: `MergeQueue.ensureMergeable()` in
[`src/engine/queue/mergeQueue.ts`](../src/engine/queue/mergeQueue.ts), called from
`dequeueNext()` for every member PR of a bundle as it lands. GitHub's `mergeable_state` for
the PR routes it one of four ways:

- `clean` / `hasHooks` / `draft` → merge directly, no resolver involved.
- `behind` → free GitHub branch update (`updateBranch`), no LLM, then re-check.
- `blocked` / `unstable` / unrecognized → **not** a merge conflict (branch protection,
  failing CI). Bail immediately; the resolver has no business touching these.
- `dirty` → the actual conflict path. Everything below is this path.

The resolver is a five-tier escalation, cheapest-and-most-deterministic first. Each tier
either resolves the conflict or hands a **structured** reason to the next tier — nothing
falls back to a bare string until the human sees it.

**Tier 0 — SHA triage**, `planFileResolutions()` in
[`conflictResolution.ts`](../src/engine/queue/conflictResolution.ts). Compares blob SHAs
across merge-base/ours/theirs for every touched path *before* fetching any blob content.
Settles `takeOurs` (theirs didn't touch it) and `takeTheirs` (ours didn't touch it) for free;
routes real mode/submodule/delete-vs-modify disagreements straight to `structuralConflict`
(no line-based merge is possible, fail immediately); only genuinely three-way-divergent files
reach the next tier.

**Tier 1 — diff3 + mechanical hunks**, [`conflictHunks.ts`](../src/engine/queue/conflictHunks.ts).
`node-diff3`'s `diff3Merge()` does the real three-way merge and returns ordered regions
(`ok` / `conflict`). Within each conflict hunk, `classifyHunk()` checks whether both sides
agree modulo leading/trailing whitespace — if so it's `mechanical` and resolves for free
(favor `ours`, arbitrarily but consistently). Only genuinely divergent hunks are `semantic`.

**Tier 2 — semantic hunk resolver**, [`semanticHunkResolver.ts`](../src/engine/queue/semanticHunkResolver.ts).
**One batched LLM call for every semantic hunk in the file**, not one call per hunk — this is
the main cost lever. The PR's `declaredDirection` is passed as a tiebreaker. Up to 3 retries
(`MAX_HUNK_RESOLUTION_ATTEMPTS`) with specific feedback fed back to the model (unparseable
JSON, a missing hunk, leftover conflict-marker text); hunks a given attempt resolved validly
survive across retries so a retry only fixes what's actually wrong. If `syntaxContext` is
supplied, the *combined* file (mechanical + semantic resolutions together) is run through a
real TS/JS parse (`checkSyntax.ts`) before being accepted — a hunk can be fine in isolation
and still leave a dangling brace once stitched to its neighbors. Anything still `low`
confidence after 3 attempts fails the file, carrying the specific reason (parse error, missing
hunk, model's own stated uncertainty) into the human-facing disclosure.

**Tier 3 — deep conflict investigation** (opt-in), [`deepConflictInvestigation.ts`](../src/engine/queue/deepConflictInvestigation.ts).
When Tier 2 fails, and the repo has `enableDeepConflictInvestigation` on, and the team's
connected LLM account is Anthropic, Quire starts a **Managed Agents** session: Opus-tier,
read-only (`Contents:Read`-scoped token — even if the agent tried `git commit`/`git push`,
GitHub would reject it), with `bash`/`read`/`grep`/`glob` only. It gets `git log`/`git blame`
context, greps for call sites, optionally runs a *scoped* test file, and returns exactly one
JSON decision packet (rationale, evidence, confidence, a full-file `proposedResolution`) —
one propose-then-verify pass, not an open loop. The agent+environment pair is created once
and persisted to `statePath`, reused across every investigation.

**Tier 4 — human.** The bundle sits in the merge queue with `status: "conflict"` (or
`"investigating"` while Tier 3 runs). A finished investigation moves it back to `"conflict"`
with `status: "awaitingReview"` on that file — a human explicitly **accepts** (Quire commits
the proposed resolution through its own `commitResolvedFiles` pipeline, never trusting a write
the agent claims to have made) or **rejects** it. Nothing at Tier 3 auto-applies. Absent that,
a human fixes it manually on the PR branch and either clicks "Retry" or just pushes — the
`synchronize` webhook calls `reattemptForPr()` automatically.

**Two adjacent, non-tiered mechanisms worth knowing about:**
- [`conflictOrder.ts`](../src/engine/bundle/conflictOrder.ts) — orders the *review queue* (not
  the merge queue) so bundles with disjoint file footprints surface first and entangled ones
  sink, so fewer bundles need rebasing by the time a human reaches them. Doesn't touch
  resolution; it changes the odds a conflict happens at all.
- `MergeQueue.refreshQueuedBranches()` — a periodic pass (`QUIRE_QUEUE_REFRESH_INTERVAL_MINUTES`,
  default 5) that fast-forwards `behind` PRs before their turn, for free, so drift doesn't
  calcify into a real Tier-1+ conflict by the time `dequeueNext()` reaches them.

---

## 2. Why it's shaped this way

**This is the third architecture, not the first.** Reading the git log before touching this
code will save you from re-proposing something already tried and abandoned:

1. **v1 — inline LLM call per file** (`8ae814b` era). A synchronous, single-file,
   context-starved call to Haiku inside the Quire process. Worked, but had no real repo
   context and couldn't verify its own edits.
2. **v2 — GitHub Action** (`fa34fb5`). Dispatched the *whole PR* to a `claude-code-action` run
   in the target repo's own runner the moment diff3 couldn't resolve a file — real checkout,
   full context, could verify edits. This is where it got expensive to operate: `2340bca`
   documents a live run that took 8m27s, burned 25 turns, and hit **8 permission denials**
   before still failing, because the step had no `permission-mode`/`max-turns` and kept
   retrying around its own denials. Needed a per-repo `ANTHROPIC_API_KEY` secret, OIDC
   permissions, stale-SHA handling, and a callback-plus-poll dance back into the queue. Every
   fix was structural, not incidental — this is why v2 was replaced rather than patched
   further.
3. **v3 — the current tiered in-process resolver** (`43f84ed`). Quire's server already fetches
   the merge trees and runs `diff3` in-process; it only lacked hunk-level classification. So:
   classify hunks, resolve mechanical ones for free, batch the rest into **one** call to
   Quire's *already-configured* LLM account (no separate key, no dispatch machinery, no
   `"resolving"` queue state to poll), fail closed to the human queue on low confidence. Tier 3
   (Managed Agents) was added later (`7693c28`) as an *opt-in* escalation for the tail Tier 2
   still can't clear — but scoped to a single file with a read-only token and human sign-off,
   deliberately not a repeat of v2's "escalate the whole PR to an unsupervised agentic run."

**The cost curve is deliberately front-loaded toward free/cheap.** Tier 0 needs zero blob
fetches for most files in a "dirty" PR (most weren't touched by both sides at all). Tier 1's
mechanical classification is free. Tier 2 is one batched call *per file*, not per hunk — hunk
count doesn't multiply cost. Tier 3 is Opus-tier and comparatively expensive, but only runs on
the tail Tier 2 already rejected with low confidence, so cost tracks difficulty, not volume.

**Fail-closed is the load-bearing invariant (INV-6 in the main product spec: "surface what the
system could not clear").** Every tier that isn't confident hands a *structured* reason to the
next tier rather than guessing — `ConflictHunkEscalation` carries the actual hunk content and
the rejected resolution forward to Tier 3; a rejected Tier-3 packet leaves the bundle exactly
in `"conflict"`, not a worse state. No tier ever silently picks a side when it isn't sure.

**Read-only agent, Quire applies the write.** Tier 3's token is `Contents:Read`-scoped and its
toolset has `write`/`edit` disabled — belt and suspenders. Even a fully "convinced" agent
cannot commit its own resolution; Quire re-applies the proposed text itself, and only after a
human clicks accept. This is a deliberate defense-in-depth choice, not an oversight — do not
"simplify" it by giving the agent write access.

**Everything side-effecting is serialized through one lock** (`856a98b`). `dequeueNext()`,
`reattempt()`, `abort()`, and webhook-driven `recordExternalMerge()` are each reachable from
independent triggers (a human's click, `autoMergeOnAccept`, a GitHub webhook) that don't
coordinate with each other. `MergeQueue.withLock()` chains them onto `this.state` so two
triggers landing concurrently can't silently drop one side's update. `refreshQueuedBranches()`
deliberately does **not** take the lock — it's read-mostly and must not block `dequeueNext()`
for the time a full pass over the queue takes; a duplicate `updateBranch()` call racing it is
harmless.

---

## 3. Runbook — when it breaks

**Where to look first, always:** the queue entry itself
(`data/teams/<teamId>/queue.json`, or `GET` the bundle via the API) — `status`, `conflict.reason`,
`investigations[]`. Then the conflict-resolution NDJSON log at `conflictLogPath`
(`logConflictResolution()` writes an entry — `resolved` or `unresolved` with a reason — at
every resolution attempt, at every tier).

| Symptom | Where to look | What's actually happening |
|---|---|---|
| Bundle stuck in `"conflict"` | `entry.conflict.reason` | A tier failed with a specific reason string — read it, it's usually literally correct (a real incompatibility, a binary file, a submodule change). Not a bug by default. |
| Bundle stuck in `"landing"` across a restart | `entry.mergedPrIds` vs. GitHub's actual state | `dequeueNextLocked()` resumes a `"landing"` entry automatically on the next call — it should self-heal. If it doesn't, check whether `mergePullRequest()` succeeded on GitHub but the process crashed before persisting `mergedPrIds` (this exact bug was fixed in `6adaf96`, but check `getMergeability()`'s `merged` field is actually being honored — if it regresses, the symptom returns). |
| Repo has `enableDeepConflictInvestigation` on, but Tier 3 never starts | Server logs for `Deep conflict investigation failed to start for ...` | `tryStartInvestigation()` in `mergeQueue.ts` is **best-effort and swallows every failure to `console.error` only** — the human never sees it, they just silently get the plain `"conflict"` path with no investigation. Check: (1) the team's `llm-account.json` provider is literally `"anthropic"` — Tier 3 has no wiring for any other provider regardless of the repo setting; (2) `ensureDeepResolverAgent`'s persisted state file is readable and not corrupt; (3) `mintRepoToken` isn't failing (installation token scoping). **This is the top sharp edge in this subsystem — see §4.** |
| An investigation sits in `"running"` forever | Whether `pollInvestigations()` is actually wired into a periodic interval in this deployment | `pollInvestigationSession()` never blocks — it's meant to be polled from a `setInterval`, same pattern as `refreshQueuedBranches()`. If nothing is calling `pollInvestigations()` on a schedule, sessions never resolve. Check `src/interface/server/index.ts` for the interval registration before assuming Managed Agents itself is stuck. |
| Semantic hunks always resolve `low` confidence for a specific file type | `checkSyntax.ts` | The syntax gate is TS/JS-only (`ts.transpileModule`). For any other language it's simply not checked — not "checked and passing," just skipped. If a non-JS/TS repo's hunks are failing at a *suspiciously* high rate, it's not the gate; look at the model's own stated reasons in `SemanticHunkResolution.reason` first. |
| A resolution combines fine per-hunk but the file doesn't parse | `checkSyntax.ts` gate firing, `resolved.clear()` in `resolveSemanticHunks` | This is intentional: on a combined-syntax failure, *every* hunk's resolution for that attempt is discarded (not just the offending one) because the break could have come from any hunk's interaction with its neighbors — the next retry revises the whole batch. If retries keep exhausting on this, the file likely needs a human, not a 4th attempt. |
| A mechanical (whitespace-only) resolution picked the "wrong" side | `resolveMechanicalHunk()` | By design, always takes `ours` (the incoming PR). If `ours` vs `theirs` differ only by whitespace, this is a no-op semantically — if it's visibly wrong, the hunk wasn't actually whitespace-only and `classifyHunk()` has a bug; that would be a real regression, not expected behavior. |
| Queue looks "wedged" with nothing landing despite several `"queued"` entries | Whether `dequeueNext()` is being called at all, and by what | Processing is **not automatic on enqueue** — it's driven by a human's "Process" click, `autoMergeOnAccept`, or a caller invoking `dequeueNext()`. Confirm the polling/trigger path for this deployment before assuming the resolver itself is broken. |

**Manual levers (owner-only routes):**
- Retry a conflicted bundle: `POST /queue/:bundleId/retry` → `reattempt()` — clears `conflict`/
  `aborted` back to `queued`; `mergedPrIds` is untouched, so a partially-landed bundle resumes
  where it left off.
- Abort a stuck bundle: `POST /queue/:bundleId/abort` → terminal `"aborted"`; does **not**
  revert already-merged members (that's `revertPr`, a separate explicit action per INV-4).
- Accept/reject an investigation's proposal: the review UI's accept/reject actions call
  `acceptInvestigation`/`rejectInvestigation` directly against a specific `path` — there is no
  bulk-accept.

**Instrumentation:** `logConflictResolution()` is the audit trail for every attempt at every
tier. If you're debugging a pattern (e.g. "Tier 2 fails constantly on this repo"), grep that
NDJSON file before adding new logging — it likely already has what you need.

---

## 4. Known sharp edges & tech debt

Ranked roughly by how likely each is to actually bite someone:

1. **Deep-investigation start failures are invisible to the human.** `tryStartInvestigation()`
   catches everything and only `console.error`s. A team that turned on
   `enableDeepConflictInvestigation` and expects Tier 3 to be running has no product-level
   signal when it silently isn't (wrong LLM provider, expired token, Managed Agents API
   hiccup). If you're asked "why didn't the deep resolver even try," start here — it's a code
   read, not a queue-state read, because the queue looks identical to the plain-conflict path.

2. **Tier 3 is Anthropic-only, full stop.** `tenant.ts` only constructs an
   `AnthropicManagedAgentsClient`; a team on Gemini (drift detection supports a
   `geminiProvider.ts`) gets zero deep-investigation tier no matter what they set on the repo.
   This isn't documented anywhere a repo owner would see it before toggling the setting.

3. **The syntax gate is single-language.** `checkSyntax.ts` only validates TS/JS. Per the root
   `CLAUDE.md`'s module-boundary rule, static analyzers are supposed to be pluggable per
   language (this is exactly the pattern the *drift-detection* footprint analyzer already
   follows) — the conflict-resolution syntax gate never got that treatment. Any other language
   silently skips this safety net; the resolver doesn't degrade loudly, it just has one fewer
   check.

4. **Bounded retries (3) assume transient failure, not systematic model regression.** If a
   model update makes the semantic resolver consistently need a 4th attempt to converge, every
   affected file quietly funnels to the human queue with no alarm distinguishing "genuinely
   hard conflict" from "the model got worse." Nothing currently tracks retry-exhaustion rate as
   a metric on its own.

5. **The Managed Agents agent+environment pair has no rotation path.** Created once, persisted
   to `statePath`, reused forever (per Managed Agents' own guidance against recreating per
   session). If the underlying model (`claude-opus-4-8`, hardcoded in
   `deepConflictInvestigation.ts`) is deprecated, or the org's API key rotates in a way that
   invalidates the persisted agent, there's no code path that notices and recreates it — you'd
   delete the state file by hand.

6. **No per-conflict cost attribution.** Same gap as the team-wide LLM key issue in
   [`team-design.md`](team-design.md) — a team burning unusual spend on Tier 2/3 conflict
   resolution specifically (vs. drift detection, which shares the same key) has no way to see
   that split today.

7. **History lesson, not a current bug:** if anyone proposes moving conflict resolution back
   out-of-process (a GitHub Action, a separate service, anything that isn't "Quire's own server
   does it inline") — read `fa34fb5` and `2340bca` first. That path was tried, and the
   permission-thrash/stale-SHA/OIDC fragility it produced is exactly why the current
   architecture exists. It's not that out-of-process is impossible, it's that the specific
   failure modes are known and expensive, so any re-proposal needs to explain what's different
   this time.

---

## 5. File map

| File | Tier | Role |
|---|---|---|
| `src/engine/queue/mergeQueue.ts` | orchestration | Queue state machine; `ensureMergeable`/`attemptResolution` decide which tier(s) run |
| `src/engine/queue/conflictResolution.ts` | 0–2 driver | `planFileResolutions`, `resolveMergeConflict` — ties triage → diff3 → semantic together |
| `src/engine/queue/conflictHunks.ts` | 1 | `diff3Merge` wrapper, hunk extraction, mechanical classification/resolution, file reconstruction |
| `src/engine/queue/semanticHunkResolver.ts` | 2 | Batched LLM call, retry-with-feedback, syntax gate |
| `src/engine/queue/checkSyntax.ts` | 2 (gate) | TS/JS-only whole-file parse check |
| `src/engine/queue/deepConflictInvestigation.ts` | 3 | Managed Agents session lifecycle: create/reuse agent, start investigation, poll, parse decision packet |
| `src/engine/queue/managedAgentsClient.ts` / `stubManagedAgentsClient.ts` | 3 | Real vs. test double for the Managed Agents API |
| `src/engine/bundle/conflictOrder.ts` | adjacent | Review-queue ordering to reduce entanglement (not resolution) |
| `src/interface/server/tenant.ts` | wiring | Where `DeepInvestigationDeps` is actually constructed per tenant — start here to trace "is Tier 3 even wired up for this team" |
| `tests/unit/conflictResolution.test.ts`, `conflictHunks.test.ts`, `mergeQueue.test.ts`, `deepConflictInvestigation.test.ts`, `conflictOrder.test.ts` | — | Existing coverage; read before changing tier boundaries |

---

## 6. Suggested live walkthrough agenda

For the pairing session — don't just re-read this doc out loud, drive the actual system:

1. Trigger a real `dirty` PR locally (two branches editing the same lines) and walk it through
   all five tiers live, pointing at the queue entry's `status` changing at each step.
2. Deliberately break Tier 2 (feed it two genuinely incompatible edits) and show the
   low-confidence disclosure reaching the review card.
3. Turn on `enableDeepConflictInvestigation` for a test repo, trigger Tier 3, and show the
   accept/reject flow — including what the queue looks like while `"investigating"`.
4. Kill the server mid-`"landing"` and restart it — show the self-heal, and point at `6adaf96`
   as the bug this specifically guards against.
5. Walk through the sharp-edges list in §4 and ask them to reproduce #1 (silent
   deep-investigation start failure) on purpose, so they've seen it once before it happens to
   them for real.
