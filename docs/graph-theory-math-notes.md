# Graph-theory / combinatorics ideas for Quire

**Status**: research notes, not specs. Each idea below is scoped to a real
data structure that already exists in `src/engine/`, at a stated confidence
level — none of these are queued for implementation until an issue for them
is picked up. This doc explains *why* each technique is the right one for
the specific gap it targets; it does not stay current on implementation
status — the linked GitHub issue is the living version of "what's left."

## Why this file exists

A separate research pass (on an unrelated project, an AI app-builder called
mythwork) cataloged where graph theory, topology, and combinatorics could
replace ad hoc heuristics in that codebase. Reading through it turned up a
real, non-coincidental structural echo: mythwork's Build Manager schedules
parallel AI edit batches with a dependency DAG + conflict graph, and its
Discover surface clusters apps by a similarity graph with a hand-picked
threshold. Quire's own bundling (`src/engine/bundle/similarity.ts`) already
*is* a connected-components computation over a PR-similarity graph, its
symbol-coherence check (`src/engine/drift/symbolCoherence/check.ts`) already
groups PRs into per-symbol "faces," and its merge queue already computes a
pairwise file-overlap score (`src/engine/bundle/conflictOrder.ts`) — just not,
yet, as a graph used for anything beyond display order. That's a genuine fit,
not a copy-paste of someone else's catalog: four ideas below are grounded in
Quire's actual code, not adapted from mythwork's app/tag/favorites domain
(most of which — PageRank over a favorites graph, Erdős–Ko–Rado tag-overlap
significance, formal concept analysis over tags — has no analogue in Quire at
all, since Quire has no tags, favorites, or recommendation surface).

Each idea is tagged with a maturity tier, borrowed from the same research
pass's convention:
- **Near-term** — buildable roughly as described, no open research question.
- **Exploratory** — the idea is sound but needs a throwaway prototype/measurement
  before it's worth speccing for real.

---

## 1. Persistence-based threshold selection for bundle clustering

**Tier: Exploratory.** Issue: [#247](https://github.com/ethanluh/quire/issues/247)

**The gap.** `clusterPRs()` (`src/engine/bundle/similarity.ts:102`) already
builds exactly a similarity graph: each PR is a node, an edge exists when two
PRs' extracted-effect-text cosine similarity clears `config.threshold`, and a
bundle is a connected component of that graph (the file's own comment calls
this out directly — "connected-components... not nearest-neighbor"). The
threshold is a single hardcoded value, `0.75`
(`src/interface/server/index.ts:53`), picked once with no stated
justification — exactly the kind of arbitrary cutoff a threshold-sensitivity
technique exists to replace.

**The math.** Treat the similarity graph as a filtration: instead of building
it once at threshold 0.75, build it at every threshold from 0 to 1 (or a
reasonable sample of thresholds) and track connected components as the
threshold sweeps. A connected-components computation is **persistent
homology's H₀ in miniature** — every component has a birth threshold (the
similarity value at which its members first joined) and would have a death
threshold if lowering the threshold further merged it into a bigger one.
**Persistence** = death − birth. A grouping of PRs that stays a stable,
distinct component across a wide range of thresholds is a structurally real
direction-cluster; one that only exists at one narrow threshold band is an
artifact of exactly where 0.75 happens to sit.

**What it would change concretely.** Not necessarily the clustering algorithm
itself — the connected-components approach is already right. What's missing
is *evidence for the threshold value*. A calibration pass (in the spirit of
Phase 0 — see `CLAUDE.md`) that sweeps thresholds over a representative PR
sample and reports how bundle membership churns near 0.75 would tell us
whether 0.75 is sitting in a stable region or right on a boundary where a
small effect-text wording difference flips which bundle a PR lands in.

**Caveat.** Computing full persistent homology is unnecessary machinery here
— Quire only needs H₀ (component birth/death), not H₁ (cycles), and the graph
is small (tens of PRs, not thousands), so a direct threshold sweep with plain
union-find at each step is enough; no persistent-homology library is needed.

---

## 2. Spectral cohesion score as a bundle-review disclosure

**Tier: Near-term.** Issue: [#248](https://github.com/ethanluh/quire/issues/248)

**The gap.** A bundle accepted by `clusterPRs()` can be a single strong
cluster, or it can be two sub-groups bridged by one PR whose similarity to
each just barely clears 0.75 — the connected-components framing accepts both
cases identically, and the review card currently has no way to distinguish
"tightly-directed bundle" from "barely-one-bundle." INV-6 already commits
Quire to disclosing what the system couldn't clear; a bundle that's one
component only because of a single weak bridging edge is exactly this kind
of residual.

**The math.** Build the weighted similarity subgraph *within* one bundle
(nodes = member PRs, edge weight = the cosine similarity `clusterPRs()`
already computed pairwise). Its graph Laplacian `L = D − A` has a smallest
eigenvalue of 0 (always) and a second-smallest eigenvalue λ₁ — the **Fiedler
value**, or algebraic connectivity. λ₁ near 0 means the bundle is "nearly
disconnected" — close to being two separate directions joined by one thin
similarity edge; a larger λ₁ means the bundle is well-knit, every member
strongly resembles every other. **Cheeger's inequality** formalizes this: λ₁
provably bounds the graph's sparsest-cut ratio, so it isn't just a
correlated heuristic, it's a real bound on how easy the bundle would be to
split into two.

**What it would change concretely.** Compute λ₁ per bundle at review-card
generation time (`src/engine/review/card.ts`) and surface a "cohesion" signal
alongside the existing drift verdict — not a new drift flag under INV-2/INV-3
(no independent check clears anything), just an added disclosure for a human
deciding whether to trust the grouping. Cheap: this reuses similarity scores
`clusterPRs()` already computed, needs no new LLM/embedding calls, and the
per-bundle subgraph is small (bundle sizes are small in practice).

---

## 3. Higher-order (multi-name) symbol-coherence conflicts

**Tier: Exploratory.** Issue: [#249](https://github.com/ethanluh/quire/issues/249)

**The gap.** `findSymbolInconsistencies()`
(`src/engine/drift/symbolCoherence/check.ts:12`) groups touches into "faces"
keyed by a single symbol name (the file's own comment already uses this
"face"/"k-way interaction" language) and flags a name one member
removes/renames while another still references. That catches every
inconsistency visible *within one name's face*. It structurally cannot catch
a conflict that only exists *across* two different names: e.g. PR-A renames
`foo` → `bar`, and unrelated PR-B independently adds a new, different symbol
also named `bar` — no single face sees both operations as inconsistent
(each face, taken alone, looks like an ordinary add or an ordinary rename),
but the bundle's post-merge world has two members disagreeing about what
`bar` means.

**The math.** This is precisely the gap between a **graph** and a
**simplicial complex**. A conflict *graph* (or, here, the flat per-name face
map) only encodes what's visible when looking at one name's touches at a
time — a pairwise/single-face view. Modeling the bundle's touches as a
simplicial complex — faces can be higher-dimensional, joining touches across
*different* names when they share a file or an execution/ordering
relationship — closes exactly this kind of false-negative: three (or more)
touches across two different symbol names can jointly conflict even though
no single name's face looks wrong alone.

**What it would change concretely.** Extend `findSymbolInconsistencies` (or
add a sibling check) to also group touches by **file**, not just by symbol
name, and cross-reference: a file where one member renames a symbol that
another member (in the same file, without referencing the old or new name
directly) introduces a same-named new symbol is a 2-face conflict the
current per-name check misses entirely. This is a bounded, concrete
extension — not full simplicial-complex machinery — that closes a real,
already-named class of false negative without touching INV-2/INV-3 (still a
flag, never a clear).

---

## 4. Cross-bundle conflict graph for merge-queue scheduling

**Tier: Near-term.** Issue: [#250](https://github.com/ethanluh/quire/issues/250)

**The gap.** `MergeQueue.dequeueNextLocked()`
(`src/engine/queue/mergeQueue.ts:156`) is strictly FIFO: it picks the single
oldest "landing" or "queued" entry and processes it to completion before
looking at the next one. Two bundles that don't touch a single file in
common still queue and land one after the other, serially — the same
"binary heuristic serializes an entire batch" inefficiency the mythwork
research pass flagged in an unrelated scheduler, and Quire already computes
the exact data this would need to fix it: `orderByConflictRisk()`
(`src/engine/bundle/conflictOrder.ts:12`) already builds a pairwise
file-footprint-overlap count ("entanglement") between every pair of pending
bundles — today used only to pick *display order* for the human review
queue, never to inform actual merge scheduling.

**The math.** Model queued bundles as nodes and an edge wherever
`orderByConflictRisk`'s existing footprint-overlap check is non-zero — this
is already, structurally, a **conflict graph** (nodes = pending merge
candidates, edges = file-overlap). A **maximal independent set** in that
graph is exactly the largest group of bundles that share no files at all and
could safely land without any of them being invalidated by another's
merge — the same graph-coloring/independent-set pattern used to batch
non-conflicting edits for parallel dispatch elsewhere (a technique with a
provable-optimality upgrade path via **matroid intersection** if the
constraint ever needs to jointly respect both file-overlap and a resource
cap, e.g. a limit on concurrent in-flight merge commits).

**What it would change concretely.** Nothing about *how* an individual
bundle merges (INV-4/INV-5 — accept enqueues, revert operates per-PR — are
untouched). What changes is queue *order*: instead of always picking the
single oldest entry, `dequeueNextLocked` could pick the oldest entry among
those with **zero footprint overlap with every currently-landing entry**,
letting genuinely independent bundles land without waiting behind an
unrelated bundle stuck resolving a conflict. Even a simple greedy version
(skip an entry if it overlaps anything currently mid-merge) captures most of
the benefit without a full graph-coloring pass.

---

## What didn't transfer, and why

For completeness: most of the mythwork catalog doesn't apply here at all,
and forcing it in would misrepresent what Quire does. Its highest-value
ideas — personalized PageRank over a favorites graph, Erdős–Ko–Rado-style tag-
overlap significance testing, formal concept analysis over a tag taxonomy,
UMAP maps of an app corpus — all key off data Quire doesn't have (tags,
favorites, a recommendation surface, a spatial/visual canvas). Quire's
domain is direction-triage over a merge queue, not content discovery, so the
four ideas above — all keyed to structures Quire's own pipeline already
builds — are the actual overlap, not a port of the source catalog.
