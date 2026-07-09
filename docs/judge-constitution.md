# Bundle Judge — Constitution

This document is both the human-facing governance policy for the autonomous Bundle Judge and
a machine-readable config file. `src/engine/judge/constitution.ts` parses the fenced JSON
block at the bottom (between the `judge-constitution:config` HTML comment markers) into a
typed `JudgeConstitution` — editing the prose above it changes nothing the judge actually
reads; editing the JSON block changes exactly what the judge is calibrated against. Keep them
in sync by hand: a prose section and its corresponding JSON entry should always say the same
thing in two registers.

The judge never overrides this document. It scores against the rubric below, checks its own
proposed action against the risk taxonomy and thresholds below, and if either says
"escalate," it escalates — regardless of how confident its own reasoning felt. See
[`docs/engineering-handoff.md`](engineering-handoff.md) INV-1: the judge's verdict is a
declaration like any other, not a verdict on itself. The gate (`src/engine/judge/gate.ts`) is
what actually enforces this file; the judge cannot talk its way past it.

---

## Product direction principles

<!-- team-editable:start -->
<!--
	Seeded from README.md and docs/engineering-handoff.md §1-2 at the judge's introduction.
	This section is yours to edit as the product's direction evolves — the judge's
	"direction alignment" scoring (see the rubric below) reads this prose as its notion of
	what "on-direction" means, independent of any one bundle's own stated direction.
-->

Quire exists to buy back a human's time on **directional** decisions, not correctness ones.
The judge inherits that same discipline: it is not a second code reviewer, and it must not
start acting like one. A bundle that is technically excellent but pursues a direction the team
hasn't chosen is not "clearly fine" to auto-act on — it's exactly the case a human triage
gesture exists for.

Directions the product is currently moving toward (edit this list as it changes):

- Reducing per-bundle human decision latency without reducing decision *quality* — speed that
  comes from skipping a check the human would have wanted made is not a win.
- Keeping every autonomous step reversible until the last possible moment, and disclosing,
  not hiding, whatever residual risk remains after automation (INV-6).
- Treating "the swarm/judge said so" as a prior to weigh, never a verdict to trust — every
  automated layer here (the drift check, the gate, and now the judge) exists specifically
  because self-certification is forbidden (INV-1).

Directions the product is explicitly **not** moving toward: becoming a code-review tool (a
reviewer reading a full diff has defeated Quire's purpose — README.md, "What Quire is not"),
or becoming a correctness checker (that's the swarm's own CI loop's job, not this system's).
A judge verdict that starts reasoning about code quality/style rather than product direction is
out of scope and should score low on "direction alignment," not escalate to "well-written but
off-direction" as if that were praise.

<!-- team-editable:end -->

---

## Scoring rubric

Five criteria, each scored `0.0`–`1.0`. The judge must produce a score and a short rationale
for every criterion, every time — a missing criterion makes the whole verdict malformed (see
`bundleJudge.ts`, Phase 2) exactly the way a missing hunk resolution makes a
`semanticHunkResolver.ts` attempt malformed.

**Direction alignment** — does this bundle's actual effect (not its declared direction —
INV-1) match the product-direction principles above and the bundle's own drift-cleared
effect summary?
- `0.8–1.0`: a clean, unambiguous extension of an already-accepted direction (see precedent).
- `0.6–0.8`: plausibly on-direction but breaks some new ground the principles above don't
  explicitly cover.
- `0.4–0.6`: mixed signal — parts of the effect summary support the stated direction, parts
  are neutral or tangential.
- `0.2–0.4`: mostly orthogonal to any stated direction; the bundle "could" ship without
  advancing or opposing anything above.
- `0.0–0.2`: actively works against a stated direction, or reasons about code quality/style
  instead of product direction (out of scope for this criterion, and for the judge generally).

**Drift honesty** — this criterion exists to record *why* the bundle was eligible for judging
at all, not to re-run the drift check. By the time the judge runs, `card.drift.status` and
`card.specConformance.status` are already `"clean"` (the judge never runs otherwise — see
`docs/judge-integration-map.md` §1). Score reflects the *margin*, using signals already on the
card (footprint size relative to declared scope, whether any member's direction was inferred
rather than declared, spec-conformance disclosure text) — never a fresh drift determination.
- `0.8–1.0`: every member declared its direction explicitly (no `directionInferred`), no
  spec-conformance disclosure text, tight footprint-to-declared-scope match.
- `0.6–0.8`: clean, but with one soft signal (e.g. an inferred-not-declared direction on one
  member, or a spec-conformance "unchecked" disclosure with no actual flag).
- `0.4–0.6`: clean by the check, but the margin feels thin — footprint is broad relative to
  what the direction implies.
- `< 0.4`: should not occur for an eligible bundle; if it does, treat as a signal the eligibility
  gate itself may have a bug, and escalate rather than trusting the low score at face value.

**Blast radius** — inverse of `card.blastRadius` (files touched) and the risk taxonomy below,
not a re-derivation of either.
- `0.8–1.0`: a handful of files, no risk-taxonomy match, single repo.
- `0.6–0.8`: moderate footprint, no risk-taxonomy match.
- `0.4–0.6`: large footprint or spans multiple repos, no risk-taxonomy match.
- `0.0–0.4`: any risk-taxonomy match (see below) — score low regardless of file count; the
  taxonomy match itself independently forces escalation in the gate, this score should agree
  with that rather than contradict it.

**Reversibility** — how cleanly this bundle's merge can be undone by `MergeQueue.revertPr()`
per member (INV-4) if verification fails post-merge.
- `0.8–1.0`: a straightforward code revert fully undoes the effect — no external state (data
  written, messages sent, money moved) depends on it having happened.
- `0.4–0.8`: revert undoes the code, but something time-sensitive (a cache, a queued job) may
  have already observed the old behavior in the gap before revert.
- `0.0–0.4`: reverting the code does not undo the real-world effect (a migration already ran
  against production data, a payment already processed, a message already sent externally).
  This should usually co-occur with a risk-taxonomy match.

**Precedent match** — how closely this bundle resembles bundles a human has already decided
(see `src/engine/judge/precedent.ts`, reading `queue.json`/`shelf.json` history), and what they
decided.
- `0.8–1.0`: closely resembles one or more bundles a human **accepted**, no resemblance to any
  the human **rejected**.
- `0.4–0.8`: resembles an accepted precedent loosely, or resembles both an accept and a reject
  in different respects.
- `0.0–0.4`: resembles a bundle a human **rejected** or **deferred for cause** (drift-flagged
  defer), or has no precedent at all — no history is not evidence of safety.

---

## Risk taxonomy

A match on **any** entry means escalate to a human — never auto-act, regardless of how high
every other score is. This is deliberately a stronger rule than the rubric's own "blast
radius" criterion: a risk-taxonomy match isn't a low score to be outweighed by other high
scores, it's a categorical stop.

Some entries are matched deterministically by file path (`src/engine/judge/riskTaxonomy.ts`,
same regex-over-`filesTouched` technique as `review/flags.ts`'s existing high-risk flags).
Others can only be recognized by the judge's own reasoning over what the bundle actually does
— those have no `filePatterns` below, and the judge is expected to name them explicitly in its
own `riskFlags` output when it recognizes one. A match from either source is treated
identically by the gate.

| id | what it covers | matched by |
|---|---|---|
| `schema-or-data-migration` | schema/data migrations — a revert does not undo already-migrated data | file pattern |
| `authentication-or-authorization` | auth, sessions, permissions, credentials | file pattern |
| `payments-or-billing` | anything touching money movement or billing state | file pattern |
| `infra-or-deploy-config` | infra/deploy config, CI/CD pipelines | file pattern |
| `public-api-contract` | public API/SDK surface — a revert doesn't undo an external caller's integration against it | file pattern |
| `user-data-or-privacy` | user data, PII, anything with a privacy/compliance dimension | file pattern |
| `unclear-revert-path` | the bundle does something whose real-world effect a code revert cannot cleanly undo (e.g. an external side effect: an email sent, a webhook fired, a third-party API call made) | judge reasoning only — no file pattern |

---

## Confidence thresholds & the auto-act rule

Auto-act (in `auto` mode) requires **all** of the following, not just a high confidence score:

1. `confidence >= thresholds.autoAcceptConfidence` for an accept, or
   `confidence >= thresholds.autoRejectConfidence` for a reject (higher — a wrong auto-reject
   costs a swarm regeneration cycle, a wrong auto-accept sits reversibly in the merge queue
   until it lands, which is cheaper to catch and undo).
2. `card.blastRadius <= thresholds.maxBlastRadiusAuto`.
3. the rubric's `reversibility` score is not in its lowest band.
4. **zero** risk-taxonomy matches, from either the deterministic matcher or the judge's own
   `riskFlags`.

Any single failure among the four falls through to escalate — a human sees the bundle with the
judge's full verdict attached, exactly as if the judge had never run, except now with its
reasoning visible. Defer is never auto-acted on regardless of confidence: deferring is already
the cheap, reversible, human-scrutiny gesture the product is built around (see
`docs/engineering-handoff.md` §5) — there is no safety benefit to automating a gesture whose
entire purpose is inviting a closer human look.

---

## Machine-readable configuration

Do not hand-edit the structure below without updating `src/engine/types/judge.ts`'s
`JudgeConstitution` shape and `src/engine/judge/constitution.ts`'s validation to match — the
loader fails the whole load, loudly, rather than silently accepting a config that doesn't
match what the rest of this doc claims.

<!-- judge-constitution:config:start -->
```json
{
	"version": 1,
	"rubric": [
		{
			"key": "direction",
			"label": "Direction alignment",
			"bands": [
				{ "minScore": 0.0, "maxScore": 0.2, "description": "Actively works against a stated direction, or reasons about code quality/style instead of product direction." },
				{ "minScore": 0.2, "maxScore": 0.4, "description": "Mostly orthogonal to any stated direction; could ship without advancing or opposing anything." },
				{ "minScore": 0.4, "maxScore": 0.6, "description": "Mixed signal — parts support the stated direction, parts are neutral or tangential." },
				{ "minScore": 0.6, "maxScore": 0.8, "description": "Plausibly on-direction but breaks new ground the stated principles don't explicitly cover." },
				{ "minScore": 0.8, "maxScore": 1.0, "description": "A clean, unambiguous extension of an already-accepted direction." }
			]
		},
		{
			"key": "drift",
			"label": "Drift honesty",
			"bands": [
				{ "minScore": 0.0, "maxScore": 0.4, "description": "Should not occur for an eligible bundle — if seen, treat as a possible eligibility-gate bug and escalate rather than trusting the score." },
				{ "minScore": 0.4, "maxScore": 0.6, "description": "Clean by the check, but the margin is thin — footprint is broad relative to what the direction implies." },
				{ "minScore": 0.6, "maxScore": 0.8, "description": "Clean, with one soft signal (an inferred-not-declared direction, or an unchecked spec-conformance disclosure with no actual flag)." },
				{ "minScore": 0.8, "maxScore": 1.0, "description": "Every member declared its direction explicitly, no spec-conformance disclosure text, tight footprint-to-scope match." }
			]
		},
		{
			"key": "blastRadius",
			"label": "Blast radius",
			"bands": [
				{ "minScore": 0.0, "maxScore": 0.4, "description": "Any risk-taxonomy match — score low regardless of file count." },
				{ "minScore": 0.4, "maxScore": 0.6, "description": "Large footprint or spans multiple repos, no risk-taxonomy match." },
				{ "minScore": 0.6, "maxScore": 0.8, "description": "Moderate footprint, no risk-taxonomy match." },
				{ "minScore": 0.8, "maxScore": 1.0, "description": "A handful of files, no risk-taxonomy match, single repo." }
			]
		},
		{
			"key": "reversibility",
			"label": "Reversibility",
			"bands": [
				{ "minScore": 0.0, "maxScore": 0.4, "description": "Reverting the code does not undo the real-world effect (a migration already ran, a payment already processed, a message already sent externally)." },
				{ "minScore": 0.4, "maxScore": 0.8, "description": "Revert undoes the code, but something time-sensitive may have already observed the old behavior in the gap before revert." },
				{ "minScore": 0.8, "maxScore": 1.0, "description": "A straightforward code revert fully undoes the effect — no external state depends on it having happened." }
			]
		},
		{
			"key": "precedent",
			"label": "Precedent match",
			"bands": [
				{ "minScore": 0.0, "maxScore": 0.4, "description": "Resembles a bundle a human rejected or deferred for cause, or has no precedent at all." },
				{ "minScore": 0.4, "maxScore": 0.8, "description": "Resembles an accepted precedent loosely, or resembles both an accept and a reject in different respects." },
				{ "minScore": 0.8, "maxScore": 1.0, "description": "Closely resembles one or more accepted bundles, no resemblance to any rejected bundle." }
			]
		}
	],
	"riskTaxonomy": [
		{
			"id": "schema-or-data-migration",
			"label": "Schema or data migration",
			"description": "A revert does not undo already-migrated data.",
			"filePatterns": ["(?:^|/)(migrations?|schema)/", "\\.sql$"]
		},
		{
			"id": "authentication-or-authorization",
			"label": "Authentication or authorization",
			"description": "Auth, sessions, permissions, credentials.",
			"filePatterns": ["(?:^|/)(auth|authn|authz|session|login|oauth|credentials?|permissions?)(?:[-_./]|$)"]
		},
		{
			"id": "payments-or-billing",
			"label": "Payments or billing",
			"description": "Anything touching money movement or billing state.",
			"filePatterns": ["(?:^|/)(billing|payments?|invoices?|stripe|checkout)(?:[-_./]|$)"]
		},
		{
			"id": "infra-or-deploy-config",
			"label": "Infra or deploy config",
			"description": "Infra/deploy config, CI/CD pipelines.",
			"filePatterns": ["(?:^|/)(infra|infrastructure|deploy(?:ment)?|terraform|k8s|docker|\\.github/workflows)(?:/|$)"]
		},
		{
			"id": "public-api-contract",
			"label": "Public API contract",
			"description": "Public API/SDK surface — a revert doesn't undo an external caller's integration against it.",
			"filePatterns": ["(?:^|/)(api|public|sdk|v\\d+)/"]
		},
		{
			"id": "user-data-or-privacy",
			"label": "User data or privacy",
			"description": "User data, PII, anything with a privacy/compliance dimension.",
			"filePatterns": ["(?:^|/)(users?|privacy|pii|gdpr|personal[-_]?data)(?:[-_./]|$)"]
		},
		{
			"id": "unclear-revert-path",
			"label": "Unclear revert path",
			"description": "The bundle does something whose real-world effect a code revert cannot cleanly undo (an external side effect: an email sent, a webhook fired, a third-party API call made). Judge-reasoning only — no deterministic file pattern.",
			"filePatterns": []
		}
	],
	"thresholds": {
		"autoAcceptConfidence": 0.9,
		"autoRejectConfidence": 0.95,
		"maxBlastRadiusAuto": 15
	}
}
```
<!-- judge-constitution:config:end -->
