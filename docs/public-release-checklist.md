# What it takes to run Quire publicly

Quire currently runs as a single-user local tool: `npm run dev`, a GitHub PAT
or OAuth App connection, a tunnel (e.g. ngrok) for webhook delivery, and
account/repo state persisted to a local `data/` directory. This doc lists
what changes before Quire can be exposed on a real, always-on public host.

## 1. Stable public host (config-only)

Replace the ngrok tunnel with a real deployment (a VPS, Fly.io, Render,
etc.) that has a stable domain:

- Point `QUIRE_PUBLIC_URL` at that domain instead of an ngrok URL that
  rotates every tunnel restart.
- Update the GitHub OAuth App's "Authorization callback URL" from
  `http://localhost:3000/account/github/oauth/callback` to the production
  domain's equivalent.
- Add a production entrypoint. `package.json` currently only has `build`
  (`tsc`) and `dev` (`tsx ... src/interface/server/index.ts`) — there's no
  `start` script that runs the compiled `dist/` output under a process
  manager. Needs one, plus TLS termination and restart-on-crash.
- `GITHUB_WEBHOOK_SECRET` becomes a fixed, permanent secret instead of one
  regenerated per local session.

## 2. `localOnly` middleware is a hard blocker, not a toggle

`src/interface/server/middleware/localOnly.ts` checks the raw TCP socket
address against `127.0.0.1`/`::1`, and gates the account-connect and
repo-select routes (`src/interface/server/routes/account.ts`). This isn't
an env flag — the moment Quire runs on a real host, every request (including
from the owner's own browser) arrives from a non-loopback address and gets
rejected with 403.

Before these endpoints can work off of localhost, they need a real auth
story (login/session, not a TCP-origin check) — this is a rewrite of the
account/repo-selection admin gating, not a config change.

## 3. Token storage

`data/github-account.json` stores the connected GitHub token in plaintext
on disk. That's an acceptable tradeoff for a local single-user tool where
only the owner has filesystem access; it isn't once the box is
internet-facing. Needs encryption at rest, or a real secrets manager, before
a public deploy.

## 4. Single-tenant vs. multi-tenant — scope question

Everything above assumes "public" means *one hosted instance, one owner*
— a stable always-on version of what already runs locally. That's the
smaller lift (items 1, 3, 4 above).

If "public" instead means *one hosted Quire that other people log into with
their own GitHub accounts*, that's a much bigger lift on top of the above:

- Per-user authentication and session management.
- Per-user data isolation — today there is exactly one global connected
  account and one selected repo (`data/github-account.json`, `queue.json`);
  the data model has no concept of multiple tenants.
- Likely a GitHub App instead of an OAuth App/PAT, so each installation
  gets scoped, per-repo permissions rather than one broad token.

This scope decision should be made before starting on item 2, since it
changes what the replacement auth system needs to look like.
