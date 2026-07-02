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

## GitHub App setup

Quire authenticates against GitHub as a GitHub App, not a personal access token. You need one registered before `npm run dev` will start — it refuses to boot without the env vars below (see `.env.example` for the full, authoritative list of vars and inline notes on which ones are dev-only vs. required for a public deployment).

1. **Create the App** at [github.com/settings/apps/new](https://github.com/settings/apps/new) (use an org's settings page instead of your personal one if you want the App owned by an org).
2. **Permissions** — under "Repository permissions", grant:
   - **Pull requests**: Read-only (Quire only reads PRs; it never comments or pushes commit statuses itself)
   - **Contents**: Read-only (needed to read diffs)
   - **Metadata**: Read-only (mandatory default, selected automatically)
3. **Webhook** — check "Active" and subscribe to the **Pull request** event (covers opened/synchronize/closed, which drive Quire's queue updates between reconcile polls). The Webhook URL must be a real address GitHub's servers can reach — for local dev, leave this blank or point it at a tunnel (e.g. `ngrok http 3000` → `https://<subdomain>.ngrok.io/webhooks/github`); without it Quire falls back to polling only (`QUIRE_RECONCILE_INTERVAL_MINUTES`).
4. **URLs**:
   - **Callback URL** (OAuth, used for sign-in): `http://localhost:<PORT>/account/github/oauth/callback` in dev, or `https://<your-domain>/account/github/oauth/callback` in production.
   - **Setup URL** (App install flow): same domain, needs to be reachable by GitHub — only works once you're tunneling or deployed, same constraint as the webhook.
5. **Where to find each credential** after creating the App, all on the App's own settings page (`github.com/settings/apps/<your-app-slug>`):
   - **App ID** and **App slug** — top of the page → `GITHUB_APP_ID`, `GITHUB_APP_SLUG`.
   - **Client ID** and **Client secret** (generate one) — under "OAuth credentials on this GitHub App" → `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`. These authenticate *sign-in* only ("Sign in with GitHub") — they're never used to call the GitHub API.
   - **Private key** — generate and download the `.pem` under "Private keys", then base64-encode it into a single line: `base64 -i your-app.private-key.pem | tr -d '\n'` (macOS/BSD), or `base64 -w0 your-app.private-key.pem` (Linux) → `GITHUB_APP_PRIVATE_KEY_BASE64`. This key, together with the App ID, is the *installation* credential Quire uses for actual GitHub API calls (reading PRs, diffs) — a separate concern from the OAuth client id/secret above.
   - **Webhook secret** — set your own value under "Webhook" → `GITHUB_APP_WEBHOOK_SECRET`.
6. Fill in the resulting values in your `.env` (copied from `.env.example`), then from the running app's Account tab click "Install GitHub App" to bind an installation — this is what's persisted (per team, under `data/teams/<teamId>/installation.json`) and used for API access, distinct from signing in. Every team gets its own installation, repo selection, and PR queue, fully isolated from every other team; teammates on the same team share all of it.

## Docs

- [`docs/engineering-handoff.md`](docs/engineering-handoff.md) — full build spec: architecture, design invariants, drift-detection design, data model, phases, prior art, and success metrics.
- [`docs/design-feel.md`](docs/design-feel.md) — the intended visual/interaction tone, inferred from the product's stated values; the UI is styled to it.
- [`src/interface/ui/styles/tokens.css`](src/interface/ui/styles/tokens.css) + [`components.css`](src/interface/ui/styles/components.css) — the design-feel tone translated into design tokens and reference components; open [`src/interface/ui/styles/style-guide.html`](src/interface/ui/styles/style-guide.html) in a browser to see them.
- [`CLAUDE.md`](CLAUDE.md) — guidance for Claude Code agents working in this repo.
