# When to split quire into engine / mobile / desktop repos

Quire runs today as a single repo: an Express server + static HTML UI
(`src/interface`) driving an orchestration pipeline (`src/engine`). No
native iOS/Android client or desktop app exists yet. This doc records the
decision on when (and whether) to split into separate `engine`,
`mobile-ios`, `mobile-android`, and `desktop` repos as those clients get
built, so the call doesn't need to be re-derived from scratch later.

## Don't split preemptively

Splitting before a client's real shape is known turns every API change
during early iteration into a cross-repo version bump, for no benefit —
multi-repo overhead gets paid before there are multi-repo consumers to
justify it. Nothing changes structurally until a client actually exists.

## 1. Native iOS / Android — split immediately when work starts on each

This isn't a judgment call. Swift/Kotlin, Xcode/Gradle, and App Store/Play
Store signing and review cycles are different enough from the Node
toolchain that co-locating buys nothing. Native clients will consume
quire's engine over its existing HTTP API (`src/interface/server/routes`),
not by importing `src/engine` directly — so there's no shared TypeScript
code lost by splitting early. Split each one out the moment it starts.

## 2. Desktop — lower urgency, decide based on stack

If it's Electron/Tauri wrapping the existing web UI, it can live as a
workspace package inside the quire repo — it shares the JS toolchain and
possibly the UI code directly. No forcing function to split it out unless
visibility or CI-blast-radius reasons apply specifically to it.

## 3. Engine — extract only once there are 2+ independent consumers

Don't pull `src/engine` into its own repo/versioned package until a second
consumer needs to pin it at a different version than the web interface
does (e.g. a mobile client wants a stable engine API version while web
iterates faster). Today the web interface is the only consumer — a repo
split buys zero release independence yet. `src/engine` is already cleanly
bounded internally (LLM steps and static analyzers sit behind pluggable
interfaces, per the module-boundary rules in the root `CLAUDE.md`), which
is good prep for the eventual extraction, but "cleanly separated in one
repo" and "needs to be a separately versioned package" are different
thresholds.

## 4. Visibility is the one real forcing function — handle it narrowly

GitHub visibility is repo-level, not folder-level, so it's the one
constraint no amount of workspace tooling solves. If a specific component
genuinely needs different visibility than the rest, split only that
component out — don't let one visibility requirement justify splitting
everything else that has no other reason to be separate yet.

## Target visibility once split

Quire's current repo is private with no license — a proprietary B2B tool,
not an open-source play. That posture should hold across the future repos:

- **Engine → always private.** It holds the actual product IP: gate
  criteria, bundling logic, and drift detection (effect-list extraction,
  footprint analysis, behavioral confirm). No reason to expose it.
- **Mobile (iOS/Android) and desktop → private by default.** The one
  legitimate argument for making a client public is trust, not
  community/contribution: quire's GitHub App requests broad repo access,
  and a thin client — no embedded logic, just calls the API — is safe to
  open-source precisely because the actual smarts stay server-side in the
  private engine. That lets a customer audit exactly what the client does
  with the access it's been granted. Flip a client to public only if a
  customer or design partner actually asks to audit it, not by default and
  not on a calendar date.

## Low-cost prep, if wanted, before any of this is needed

- Keep the HTTP API contract in `src/interface/server/routes` documented
  and stable — that's what any future native client will actually
  consume, so its stability matters more than repo layout does.
- npm/pnpm workspaces (`packages/engine`, `apps/web`, `apps/desktop`) get
  most of the CI/build-isolation benefit without paying cross-repo
  overhead, if build times become a genuine problem before a real repo
  split is warranted.
