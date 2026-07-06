# Contributing to Quire

## Prerequisites

- Node 20 (matches CI in [`.github/workflows/ci.yml`](.github/workflows/ci.yml)).
- A GitHub App registered for local development — see the README's [GitHub App setup](README.md#github-app-setup) section. Quire refuses to start without one.

## Setup

```bash
npm install
cp .env.example .env   # fill in the values described inline
npm run dev
```

`npm run dev` loads `.env` automatically (via `tsx --env-file-if-exists`) and serves the app at `http://localhost:3000` (override with `PORT`).

## Before opening a PR

Run the same three checks CI runs:

```bash
npm run build   # tsc
npm test        # jest
npm run lint    # tsc --noEmit
```

The PR template also asks you to:
- Add a `<!-- declared-direction: ... -->` HTML comment stating the PR's product-direction intent in one sentence. This is how Quire ingests its own PRs when dogfooding against this repo — see "Pull request discipline" in [`CLAUDE.md`](CLAUDE.md).
- Link any tracked issue the PR addresses with a closing keyword (`Closes #123`, `Fixes #123`, `Resolves #123`).
- Note which build phase (from `CLAUDE.md`) the change touches, and flag anything that touches invariants INV-1 through INV-6.

## Code style

- TypeScript strict mode throughout — no `any`.
- Tabs for indentation.
- Named exports only (no default exports).
- `interface` for object shapes; `type` for unions and aliases.

## Project layout

- `src/engine/` — orchestration pipeline: ingest, gate, bundle, drift detection, queue, review-card generation. Language-agnostic; LLM-backed steps and static analyzers sit behind pluggable provider interfaces.
- `src/interface/server/` — the Express server: routes, auth/session middleware, GitHub webhook handling.
- `src/interface/ui/` — the server-rendered HTML/CSS frontend (no framework). `src/interface/ui/styles/style-guide.html` is the design-token/component reference.
- `tests/` — `unit/`, `integration/`, and `mocks/`.

For the full architecture — data model, drift-detection design, build phases, and the invariants that must never be violated — read [`CLAUDE.md`](CLAUDE.md) and [`docs/engineering-handoff.md`](docs/engineering-handoff.md) before making a structural change.

## Reporting issues

Open a GitHub issue with reproduction steps. If you've found a security issue, please don't open a public issue — see below.

## Security

If you believe you've found a security vulnerability, please use GitHub's private vulnerability reporting (the "Report a vulnerability" button under this repo's Security tab) rather than opening a public issue.
