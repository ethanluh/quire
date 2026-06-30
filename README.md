# Quire

Direction-triage for swarm PRs.

A *quire* is a gathered set of leaves bound together — the unit this product operates on: a bundle of PRs gathered by shared direction. (Pronounced like "choir"; favor the written form where the spelling matters.)

---

## What it does

Coding-agent swarms produce PRs faster than humans can review them. The bottleneck is not correctness — CI and the agents' own loops handle that. The bottleneck is **directional decisions**: a human deciding whether a feature goes the right way for the product.

Quire buys back that time by grouping PRs that pursue the same product direction into a **bundle**. The human makes one directional decision per bundle — accept, defer, or reject — instead of one per PR.

The value proposition rests on a single bargain: the human stops checking correctness and checks only direction. That bargain is only safe when the bundle's stated direction is an honest description of what every PR in it actually does. The drift-detection system (see `docs/engineering-handoff.md`) is what guards that honesty.

---

## Gestures

| Swipe | Action | Effect |
|-------|--------|--------|
| Right | Accept | Enqueues bundle to merge queue — reversible until landed |
| Left  | Reject | Discards bundle — swarm regenerates |
| Down  | Defer  | Shelves for closer inspection — does not break triage rhythm |

---

## What Quire is not

- Not a code-review UI. A reviewer reading 800 lines of diff has defeated the purpose.
- Not a correctness checker. If the upstream generation pipeline cannot be trusted for correctness, Quire is the wrong tool.
- Not a decision-maker. It surfaces signal; the human's gesture is the router.

---

## Docs

- [`docs/engineering-handoff.md`](docs/engineering-handoff.md) — full build spec: architecture, design invariants, drift-detection design, data model, phases, prior art, and success metrics.
- [`docs/design-feel.md`](docs/design-feel.md) — the intended visual/interaction tone, inferred from the product's stated values; the UI is styled to it.
- [`src/interface/ui/styles/tokens.css`](src/interface/ui/styles/tokens.css) + [`components.css`](src/interface/ui/styles/components.css) — the design-feel tone translated into design tokens and reference components; open [`src/interface/ui/styles/style-guide.html`](src/interface/ui/styles/style-guide.html) in a browser to see them.
- [`CLAUDE.md`](CLAUDE.md) — guidance for Claude Code agents working in this repo.
