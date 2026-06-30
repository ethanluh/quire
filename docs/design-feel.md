# Design feel

Inferred from `README.md` and `docs/engineering-handoff.md`. Neither document
discusses visuals — this is a reading of what the *product's values* imply
about tone, independent of the current CSS, which predates this reading and
should not be treated as a baseline.

## The one-line essence

A quire is gathered leaves bound together. The product asks a human to make
one weighty, considered judgment per bundle — not to swipe fast through a
feed. The interface should feel like sitting at a **binder's or editor's
worktable**, not a game.

## The central tension the design must hold

The interaction model is three gestures (swipe right/left/down), which is the
visual grammar of dating apps and card-sorting games — fast, disposable,
addictive. The product's stated success metric is the opposite: "Do not
optimize for engagement, gesture speed, or volume processed... the win is
fewer, better-supported decisions" (§12). Every visual choice has to earn
*deliberateness* out of a gesture set that, in every other product, signals
the opposite. The card shouldn't feel like the gesture is the reward; the
judgment behind it is.

## Tone words

Calm. Deliberate. Honest. Unhurried confidence. Editorial. Archival.

## Anti-tone words

Gamified. Punchy. Alarmist. Dashboard-dense. Slick. Cute.

## Material metaphor

Lean into the name rather than away from it: bound paper, not glass and
gradients. Gathered sheets, ledger entries, a worktable with stacked trays —
not a feed, not a stream, not a control room. This isn't a request for
literal parchment skinning; it's a bias toward generous whitespace, quiet
restrained color, and one-thing-at-a-time density over dashboard density.

## How this should land on specific surfaces

- **The review card** is a dossier, not a diff. It exists precisely because
  "a reviewer reading 800 lines of diff has defeated the purpose" — the
  layout should read like a one-page briefing (direction, blast radius,
  flags, verdict), never like a code-review tool gravitating back toward
  density and monospace.
- **Drift signals** are clinical, not alarming. The screen is tuned to
  *over-flag on purpose* (§6.1) — a flag is a normal, frequent, expected
  outcome, not an emergency. Visual treatment should read as "noted for your
  attention," not a warning siren. Reserve true urgency styling for nothing
  in this system, since nothing here is actually urgent — it's all
  reversible (INV-5).
- **The residual disclosure** (INV-6) is the product's honesty made visible.
  It must never be buried, faint-printed into invisibility, or styled as
  legal boilerplate — that would quietly betray the invariant it exists to
  serve. It should sit at a calm, legible, *permanent* register: present on
  every card, not apologetic.
- **Clean vs. flagged** are distinct states but not good-vs-bad. Per §5, a
  system-flagged drift and a human-chosen defer are different reasons for
  the same shelf and must read as different signals, not be collapsed into
  one undifferentiated color.
- **The shelf tray** is a physical, spatial idea by design — "the animation
  should drop the card into a visible shelf tray so the spatial result
  teaches the meaning" (§5). This is the one place the doc explicitly asks
  for a tactile, real-world gesture rather than an abstract state change.
- **Gestures** should feel weighty and reversible at once: confident enough
  to act on quickly, but never framed as final, scored, or streak-able.
  Nothing should count gestures back to the user as a number to chase.

## What to avoid

- Confetti, streaks, counters, or any feedback that rewards throughput.
- Red/siren treatments for drift flags — they're a screen result, not a
  failure.
- Diff-heavy, monospace-dominant layouts that re-import code-review density.
- Hiding the residual disclosure in fine print.
