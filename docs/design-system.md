# Design system

A point-in-time snapshot of Quire's UI implementation — what actually exists in the
code, not what's intended. Quire is a single app rendered as two hand-written static
surfaces: `src/interface/ui/index.html` (desktop) and `src/interface/ui/mobile.html`
(mobile), sharing `src/interface/ui/styles/tokens.css` (design tokens) and
`src/interface/ui/styles/components.css` (shared component classes). There's no
component framework, no CSS-in-JS, and no build step for the frontend — Express serves
these files directly.

This doc is the implementation-facing companion to [`design-feel.md`](design-feel.md),
which is the *why* (tone, philosophy, what the product should feel like). This doc is
the *what* (the actual tokens, classes, and values in the code today). When the two
disagree, treat it as a bug in the code or a doc that needs updating — not as license to
invent a third answer.

Written 2026-07-08, alongside the conflict-badge naming-trap fix and design-system
naming-trap cleanup described below. Re-verify facts here against the cited files if
this doc has been sitting for a while — see [Sources](#sources).

## The one thing to know: status strings are not colors

Before this fix, the merge-queue's red "conflict" badge fired for *any* reason a PR
couldn't merge — branch protection, failing CI, GitHub's mergeability check timing out —
not just an actual text conflict, even though the backend (`ensureMergeable` in
`src/engine/queue/mergeQueue.ts`) already tracked the real cause internally. The bug was
structural, not cosmetic: the frontend read a status string (`"conflict"`) and assumed
its color, instead of the status carrying an explicit tier.

The fix threads a `MergeConflictKind` discriminant (`mergeConflict | blocked | unstable |
timedOut | unresolvable`) from the backend to the frontend, and the badge now maps that
discriminant onto the shared 4-tier badge vocabulary — `neutral` / `clean` / `flagged` /
`critical` — rather than inferring a color from the word itself. The same principle now
governs every status pill in the UI (see [Color system](#color-system) below): **a
status is data, a tier is a rendering decision, and the mapping between them is one
small lookup table, not a hardcoded CSS class name per status string.** Adding a new
status or cause should mean adding one line to a `*_TIER` map, never inventing a new CSS
rule.

## Design system source of truth

Precedence order, highest to lowest:

1. [`design-feel.md`](design-feel.md) — why: tone, material metaphor, anti-tone words.
2. `src/interface/ui/styles/tokens.css` — the only place a raw color/size/duration value
   may appear. Two themes (`paper` default, `ink` dark) share one set of semantic names.
3. `src/interface/ui/styles/components.css` — the only place shared component classes
   (`.card`, `.badge` + tiers, `.btn` + tiers, `.modal-*`, `.tabs`, `.settings-*`) should
   be defined. A class duplicated locally inside `index.html`'s or `mobile.html`'s own
   `<style>` block is a bug to fix, not a pattern to extend — see
   [Known gaps](#known-gaps--open-items).
4. `src/interface/ui/styles/style-guide.html` — a living demo/reference page. It renders
   swatches by reading the *live* token values (`style="background:var(--color-x)"`), so
   it can't itself drift on color — but any hardcoded example content in it (like the
   dead hex table removed in this pass) can, and code always wins over what the guide
   says if they ever disagree.
5. `index.html` / `mobile.html` — consumers. They should never invent a parallel styling
   system; if a class doesn't exist yet in `components.css`, that's the file to add it
   to, not the page.

There's no separate design-tool source of truth (no Figma file, no tokens package) — the
CSS files themselves are canonical.

## Color system

### Primitives (paper / ink)

| Role | Paper | Ink |
|---|---|---|
| Surface — page | `#efe8d8` | `#1c1812` |
| Surface — card | `#fbf6ec` | `#26201a` |
| Surface — sunken (shelf tray, recessed) | `#e6dec8` | `#2e271d` |
| Surface — overlay | `#fffdf8` | `#2c2620` |
| Border | `#ddd2b3` | `#3a3226` |
| Border — strong | `#c9bb95` | `#4d4434` |
| Text — primary | `#2c2620` | `#ece4d3` |
| Text — secondary | `#5b5142` | `#c2b89f` |
| Text — muted (AA ≥4.5:1 on all surfaces) | `#6a5f45` | `#948a6e` |
| Text — faint (deliberately sub-AA, see [Accessibility](#accessibility-standards)) | `#8f8367` | `#746c53` |
| Brand | `#7c3b32` | `#c97b5c` |
| Brand — wash | `#f1e1db` | `#3a2a23` |

No "no red for destructive" rule exists — `--color-reject` *is* a muted rose/wine, used
deliberately for the reject gesture and its tier. What the system does avoid is
*saturated, alarm-red* anywhere: see the gesture/state row below and
[`design-feel.md`](design-feel.md)'s "Red/siren treatments for drift flags — they're a
screen result, not a failure."

### Semantic roles — gesture/state tier (the 4-tier badge vocabulary)

| Tier | Color token | Wash token | Meaning |
|---|---|---|---|
| `neutral` | `--color-text-secondary` | `--color-surface-sunken` | informational, no judgment attached |
| `clean` | `--color-accept` | `--color-accept-wash` | landed / merged / passed |
| `flagged` | `--color-flagged` | `--color-flagged-wash` | routine, expected review signal — *not* an alarm |
| `critical` | `--color-reject` | `--color-reject-wash` | reject-tier: deliberate stop, or a signal grounded in static analysis / confirmed behavior rather than an LLM judgment call |

`components.css`'s `.badge-critical` comment says it plainly: it "reuses the reject
color rather than inventing a new one" — critical and reject are visually identical on
purpose, so don't go looking for a fifth color hiding somewhere.

Every status string in the app maps onto one of these four tiers through a small,
co-located lookup table in the page's script, e.g. (from `index.html` / `mobile.html`,
identical in both):

```js
const QUEUE_STATUS_TIER = { queued: 'neutral', landing: 'flagged', landed: 'clean', conflict: 'critical', aborted: 'critical', investigating: 'flagged' };
const PR_MERGE_STATUS_TIER = { pending: 'neutral', merged: 'clean', reverted: 'critical' };
const CONFLICT_KIND_BADGE = {
  mergeConflict: { cls: 'badge-critical', label: 'Conflict' },
  blocked:       { cls: 'badge-flagged',  label: 'Blocked' },
  unstable:      { cls: 'badge-flagged',  label: 'Checks failing' },
  timedOut:      { cls: 'badge-neutral',  label: 'Pending GitHub' },
  unresolvable:  { cls: 'badge-flagged',  label: "Can't merge" },
};
```

`CONFLICT_KIND_BADGE` is the direct product of [the one thing to know](#the-one-thing-to-know-status-strings-are-not-colors)
above — extend it, don't parallel it, the next time a new non-mergeable cause needs
distinguishing.

### Framework aliases

None. There's no Tailwind config, no CSS-in-JS theme object, and no build step — if
you're looking for a bridge/alias layer between these tokens and a framework's own
theme system, it doesn't exist in this repo.

## Typography

Two font families, on purpose: `--font-display` (a serif stack — Iowan Old Style /
Palatino / Georgia) carries "written, not computed" judgment text — card direction
statements, the wordmark; `--font-body` (system sans stack) carries fast-scan UI.
`--font-mono` is reserved for IDs/hashes. All three are system stacks — no network font
fetch.

| Token | Size | Designated use |
|---|---|---|
| `--text-xs` | 11px | micro labels, badges |
| `--text-sm` | 13px | meta text, badges |
| `--text-base` | 15px | body / UI default |
| `--text-md` | 17px | card direction text |
| `--text-lg` | 20px | section headers, icon sizing (`.btn-icon svg`) |
| `--text-xl` | 26px | page title |
| `--text-2xl` | 36px | display only |

Weights: `--weight-regular` (400) / `--weight-medium` (500) / `--weight-semibold` (600) /
`--weight-bold` (700). Leading: `--leading-tight` (1.2) through `--leading-relaxed`
(1.7). Tracking: `--tracking-tight` (-0.01em) through `--tracking-wider` (0.08em, used
for uppercase micro-labels like `.label` and `.settings-nav-item`/`.settings-section h4`
headers).

No explicit "never fall back to a default system font" rule is written down, but it
falls out naturally: every stack's *first* choice is deliberate and every fallback is
still a real, similarly-shaped font, never a generic `sans-serif`/`serif` alone as the
primary choice.

## Spacing, radii, shadows, motion

**Spacing** — a 4px grid, `--space-1` (4px) through `--space-16` (64px), non-contiguous
above `--space-6` (jumps to 8/10/12/16 — there is no `--space-7`, `--space-9`, etc.).

**Radii** — `--radius-sm` (4px), `--radius-md` (8px), `--radius-lg` (12px),
`--radius-pill` (999px). Comment in `tokens.css` states the intent directly: "soft but
not bubbly — bound-paper edges, not app-icon corners."

**Shadows** — three elevation steps, `--shadow-sm` through `--shadow-lg`, all built from
one `--shadow-color` per theme (a warm near-black in paper, pure black in ink) so
opacity is the only thing that changes between them. Current usage:

| Token | Used by |
|---|---|
| `--shadow-sm` | `.card` (the base card elevation — and, deliberately, `.modal-backdrop .card`: modals stay at plain-card elevation by design, see the comment at `components.css:168-170` — never "fix" this into a taller modal shadow) |
| `--shadow-md` | mobile `.stack-card` (the swipeable review card, one step above a plain card) |
| `--shadow-lg` | mobile `.stack-card.dragging` — a dragged card is the one surface that should visually "lift" while a user is physically holding it |

**Motion** — token-level CSS transitions are short and mechanical (`--duration-fast`
120ms, `--duration-base` 200ms, `--duration-slow` 360ms), always tied to a hover/focus/
active state change. `--duration-shelf` (480ms) is the one deliberate outlier: the defer
gesture's drop-to-shelf animation is the single place the spec asks the animation to
*teach* the meaning (a physical, spatial result), not just acknowledge an interaction —
see `design-feel.md`'s "shelf tray" section. Two easings only: `--ease-standard`
(a fast-out, no-bounce curve for the mechanical transitions) and `--ease-settle`
(a decelerating settle, reserved for card entrance/exit and the shelf drop) — no
spring/elastic/bounce curves exist anywhere in the system, which is a direct, literal
implementation of `design-feel.md`'s "no bounce/spring/elastic" instruction.

Consumer-level animation choreography (the shelf drop, the swipe-stack fly-away) lives in
`index.html`/`mobile.html`'s own `@keyframes` and JS-driven class toggles, built from
these same duration/easing tokens — it's a different, page-owned layer from the
token-level transitions above, and it's the one place `prefers-reduced-motion` would need
to be respected if that gap gets picked up (see [Known gaps](#known-gaps--open-items)).

## Components & iconography

- **`.badge`** — the 4-tier pill described in [Color system](#color-system). `badge-flagged`
  and `badge-critical` both carry a `drift-reveal` entrance animation (a quiet fade +
  slight rise); `badge-clean`/`badge-neutral` don't animate in, since only a review
  signal newly appearing deserves the extra beat of attention.
- **`.btn`** — outlined, not solid-filled, with one deliberate departure documented right
  in the file header: "gesture buttons are outlined... an outline that fills in only on
  interaction reads as a considered choice, not a reward to mash." Tiers: `.btn-accept` /
  `.btn-defer` / `.btn-reject`, each just setting `--btn-color`; hover inverts to a solid
  fill of that same color.
- **`.card`** — a dossier, not a diff (per `design-feel.md`): one direction statement,
  then evidence, `--shadow-sm`, a quiet settle-in animation.
- **`.modal-backdrop`** — a dossier interrupting the page, not covering it: dims the
  backdrop, but the dialog itself is just a `.card` at the same elevation as any other
  surface.
- **`.tabs`** / **`.settings-nav-item`** — two parallel non-`.btn` clickable-control
  families (desktop's top-level pane tabs, and the settings modal's own nav rail) — both
  intentional per-surface UI, not `.btn` variants, but worth knowing they don't inherit
  `.btn`'s focus-visible ring automatically (see [Accessibility](#accessibility-standards)).
- **`.shelf-tray`** — the one surface explicitly asked to be spatial/tactile rather than
  a flat state change.

**Iconography**: no icon library dependency — every icon is a hand-copied inline `<svg>`,
visually matching Lucide's style (24×24 viewBox, `stroke-width="2"`, round caps/joins).
Sizing is now uniform via `.btn-icon svg { width: var(--text-lg); height: var(--text-lg); }`
in `components.css` — a new icon button should rely on that rule rather than hardcoding
`width`/`height` on the `<svg>` itself. Note: the settings-modal close icon's *shape*
still differs between desktop (an X) and mobile (a back-chevron) even though both close
the same modal — that's a shape/interaction-pattern question, not a sizing one; see
[Known gaps](#known-gaps--open-items).

## Accessibility standards

- `--color-text-muted` is guaranteed WCAG AA (≥4.5:1) on every surface color in its
  theme — this is enforced by design intent (stated in a `tokens.css` comment), not by
  automated CI contrast checking.
- `--color-text-faint` is **deliberately below AA** and restricted to incidental/
  placeholder text only — never use it for anything that conveys required information.
- `--focus-ring` is the one sanctioned focus treatment, derived per-theme from
  `--color-brand`. `.btn:focus-visible` is the reference implementation
  (`outline: none; box-shadow: var(--focus-ring);`), also applied to `.account-panel`/
  `.modal-backdrop` inputs and selects. It is *not* currently applied to `.tab`,
  `.settings-nav-item`, or any checkbox in the app — those fall back to the browser's
  native focus outline. That's an inconsistency, not a policy; see
  [Known gaps](#known-gaps--open-items).
- The residual disclosure (`.residual`) is required by INV-6 to stay legible and
  permanent — `design-feel.md` states it "must never be buried, faint-printed into
  invisibility, or styled as legal boilerplate." In code, that's `--color-text-secondary`
  (not `--color-text-faint`) at `--text-sm`, italic, always rendered when present — never
  gate this behind a "show details" toggle.

## Per-surface conventions & divergences (desktop vs. mobile)

Desktop (`index.html`) and mobile (`mobile.html`) are two hand-written pages sharing
`tokens.css`/`components.css`, not a shared frontend with a responsive breakpoint.

**Intentional divergences:**
- Desktop's review queue renders a static list of `.card`s under `.tabs`; mobile
  reinvents the same data as a swipeable, pointer-drag `.stack-card` stack with
  drag-driven gesture stamps.
- Desktop's Settings is a two-column modal (`.settings-nav` rail + single visible
  `.settings-panel`); mobile collapses to a full-screen sheet with sections stacked
  linearly, no nav rail.
- Desktop's Merge Queue has a "Process all" bulk action; mobile's queue view doesn't
  expose the equivalent.

**Unintentional divergence — the actual cross-surface gap:** large blocks of JS and CSS
are duplicated verbatim between the two files rather than shared through any include
mechanism — badge-status logic, toast rendering, icon markup, and dozens of other
functions exist twice, edited by hand in parallel. This is not a stylistic choice, it's
maintenance debt, and it has already caused at least one confirmed live bug (the
invite-link join flow silently broke on both platforms after Account moved from a tab to
a modal, because the fix needed a copy in each file's script and only one might get
caught). See [Known gaps](#known-gaps--open-items).

## Known gaps / open items

- **Conflict-badge naming trap** — fixed in this pass; see
  [The one thing to know](#the-one-thing-to-know-status-strings-are-not-colors) above.
  Anyone adding a new non-mergeable cause in `mergeQueue.ts` should extend
  `CONFLICT_KIND_BADGE`/`QUEUE_STATUS_TIER`, not add a new hardcoded CSS class.
- **Native dialog / interaction-pattern inconsistencies** — `confirm()`/`alert()`/
  `prompt()` are used throughout both pages, mixed with the app's own themed `.modal-*`
  component and toast, for actions of comparable severity (e.g. team rename uses a
  styled input, team create uses a raw `prompt()`; GitHub-connect has no confirmation
  step, LLM-connect gets a full modal). Also flagging the close-icon shape mismatch
  (X vs. back-chevron) noted in [Iconography](#components--iconography) as a smaller
  instance of the same category. Planned as a follow-up pass.
- **`index.html` / `mobile.html` duplication** — the top cross-surface gap described
  above. No shared JS/CSS include mechanism exists yet; a follow-up pass should extract
  the byte-identical functions into `src/interface/ui/shared/*.js`, included via
  `<script src="shared/...">` on both pages, and reconcile the handful of functions that
  have quietly diverged (some are real feature gaps, not intentional platform variance).
- **Focus-visible ring coverage** — `.tab`, `.settings-nav-item`, and native checkboxes
  don't currently get the themed `--focus-ring` treatment `.btn` gets; they fall back to
  the browser default. Not fixed in this pass — noted for a future accessibility sweep.
- **`prefers-reduced-motion`** — no media query for it exists anywhere in the CSS today.
  The token-level transitions are short enough to likely be fine as-is, but the
  consumer-level choreography (shelf drop, swipe-stack fly-away) is exactly the kind of
  larger motion `design-feel.md` singles out as *meaningful* — meaning it's also the
  kind a reduced-motion user would most want to opt out of. Not evaluated in this pass.
- **Tokens removed in this pass, and why** (recorded so nobody reintroduces them without
  re-deriving the same reasoning): `--color-brand-strong` and `--color-defer-wash` were
  defined in both themes but had zero consumers anywhere in `index.html`, `mobile.html`,
  or `components.css`, and no existing interaction pattern (hover-darken, a `.badge-defer`
  tier) that would have created a legitimate slot for either. `--shadow-lg` was *also*
  unconsumed, but unlike the other two, a legitimate gap existed for it — mobile's
  dragged stack card — so it was applied there instead of deleted; see
  [Spacing, radii, shadows, motion](#spacing-radii-shadows-motion).

## Sources

- `src/interface/ui/styles/tokens.css`
- `src/interface/ui/styles/components.css`
- `src/interface/ui/styles/style-guide.html`
- `docs/design-feel.md`
- `src/interface/ui/index.html`, `src/interface/ui/mobile.html`
- `src/engine/types/queue.ts`, `src/engine/queue/mergeQueue.ts` (conflict-kind fix)

When re-verifying this doc later, spot-check the hex values in
[Color system](#color-system) and the tier tables against the live `tokens.css`/page
scripts rather than trusting this snapshot — that's exactly the kind of drift this doc
exists to catch.
