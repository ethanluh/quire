export interface SymbolRef {
	name: string;
	filePath: string;
	kind: "function" | "class" | "variable" | "type" | "export";
}

export type SymbolOperation = "add" | "rename" | "remove" | "reference";

// One member's touch of a symbol name, tagged with what happened to it — unlike SymbolRef
// (a bare declaration/import site), this captures the operation so cross-member coherence
// checking (src/engine/drift/symbolCoherence/check.ts) can tell "PR-A added this" apart from
// "PR-B still expects this to exist."
export interface SymbolTouch {
	name: string;
	filePath: string;
	kind: SymbolRef["kind"];
	operation: SymbolOperation;
}

export interface DiffHunk {
	filePath: string;
	additions: ReadonlyArray<string>;
	deletions: ReadonlyArray<string>;
}

export interface Diff {
	raw: string;
	hunks: ReadonlyArray<DiffHunk>;
}

// Last-resort label for when a PR has neither the declared-direction marker nor any
// title/body text to fall back on (see extractDeclaredDirection in octokitClient.ts).
// Distinct from any real declaration so it can never collide with real text. Combined
// with `directionInferred` below, downstream code (bundling, gate criteria, spec
// conformance) recognizes "no real declaration" without ever inferring a direction from
// the diff itself (INV-1).
export const UNDECLARED_DIRECTION = "(no declared direction)";

export interface PullRequest {
	id: string;
	repoOwner: string;
	repoName: string;
	number: number;
	// The head commit SHA at fetch time. Used to detect when a PR's content has changed
	// since a prior pipeline run (see src/engine/cache/prCache.ts) — never a verdict input.
	headSha: string;
	declaredDirection: string;
	// True when declaredDirection was synthesized from the PR's title/body because the
	// <!-- declared-direction --> marker was missing, rather than taken from an explicit
	// author declaration. Still not a real declaration under INV-1's discipline — code that
	// special-cased the old UNDECLARED_DIRECTION sentinel (bundler singleton-forcing, gate
	// duplicate/outOfScope exemptions, spec conformance) keys off this flag instead, so a
	// title/body guess never gets treated as declared-and-comparable.
	directionInferred: boolean;
	// Parsed from a GitHub closing keyword in the PR body (e.g. `Closes #12`). undefined
	// when the PR doesn't reference an issue — spec conformance has nothing to compare
	// against in that case (see src/engine/specConformance/check.ts).
	linkedIssueNumber?: number;
	diff: Diff;
	filesTouched: ReadonlyArray<string>;
	// Descriptive metadata carried straight from GitHub, not extracted from the diff — like
	// declaredDirection, these are never a drift/verdict input (INV-1's discipline applies to
	// any human-supplied label just as much as the direction marker itself).
	labels: ReadonlyArray<string>;
	assignees: ReadonlyArray<string>;
	symbolsTouched: ReadonlyArray<SymbolRef>;
	testNamesChanged: ReadonlyArray<string>;
	ciStatus: "success" | "failure" | "pending" | "unknown";
	// Only set when the Checks API (not just the legacy combined-status API) reported at
	// least one check run — lets the UI show "pending (2/5)" instead of a bare "pending".
	ciChecksSummary?: { completed: number; total: number };
}

export interface Bundle {
	id: string;
	direction: string;
	// Mirrors the anchor member's PullRequest.directionInferred — lets the review card
	// disclose that `direction` is a title/body guess, not an author declaration.
	directionInferred: boolean;
	// Extracted-effect evidence (blind to declaredDirection, INV-2) that formed this
	// bundle. The drift check compares members against this, never against
	// `direction` — declaredDirection is a label for humans, not a verdict input (INV-1).
	effectSummary: string;
	members: ReadonlyArray<PullRequest>;
	// Bundle-level, not per-PR: a human's actionable unit here is the bundle (one directional
	// decision per bundle), so who's responsible for that decision is tracked at the same
	// grain. undefined = up for grabs by anyone on the team.
	assignedTo?: string;
	assignedAt?: string;
	assignedBy?: string; // self-assign: assignedBy === assignedTo
}

export interface Effect {
	clause: string;
	matchedDirection: boolean;
}

export type DriftSignal =
	| { kind: "effectList"; prId: string; orphanClauses: ReadonlyArray<string> }
	| { kind: "footprintAnomaly"; prId: string; surprisingSymbols: ReadonlyArray<SymbolRef> }
	| { kind: "behavioralDelta"; prId: string; description: string; classified: "intended" | "unintended" }
	| {
			kind: "symbolInconsistency";
			prId: string;
			symbol: SymbolRef;
			touchedBy: ReadonlyArray<{ prId: string; operation: SymbolOperation }>;
			description: string;
	  };

export type DriftVerdict =
	| { status: "clean" }
	| { status: "flagged"; signals: ReadonlyArray<DriftSignal> };

// Distinct from DriftVerdict on purpose: drift compares declaredDirection against the
// PR's own code (evidence blind to the declaration, INV-2); this compares declaredDirection
// against the originating GitHub issue the PR claims to close — a different question
// (has the task itself been quietly redefined?), not internal code/declaration consistency.
export interface SpecConformanceSignal {
	prId: string;
	explanation: string;
}

export type SpecConformanceVerdict =
	| { status: "clean" }
	| { status: "flagged"; signals: ReadonlyArray<SpecConformanceSignal> };

export interface ReviewCard {
	bundleId: string;
	directionSummary: string;
	// Mirrors Bundle.directionInferred — true when directionSummary is a title/body guess
	// rather than an explicit author declaration, so the UI can disclose it (see
	// index.html/mobile.html) instead of presenting a guess as a real declaration.
	directionInferred: boolean;
	// Derived from the bundle's members (every ingestion run clusters PRs from a single
	// repo, see isBundleForRepo in server/refreshRepoQueue.ts) — lets the UI show/filter by
	// repo without fetching bundle detail.
	repoOwner: string;
	repoName: string;
	blastRadius: number;
	flags: ReadonlyArray<string>;
	drift: DriftVerdict;
	residualDisclosure: string;
	specConformance: SpecConformanceVerdict;
	// Always set (INV-6 style), even when empty — discloses how many members had no
	// linked issue / a failed fetch / an unparseable LLM response, so a "clean" verdict
	// above is never confused with "we couldn't check this."
	specConformanceDisclosure: string;
	// Fingerprint of everything blastRadius/flags/drift/specConformance are computed from
	// (see computeInputsHash in review/card.ts) — lets a later pipeline run prove those
	// fields are still valid without recomputing them, while directionSummary (declaredDirection
	// is metadata, not a drift-check input, INV-1) is always refreshed independent of this.
	inputsHash: string;
	memberCount: number;
	// True when `flags` includes a high-risk category (auth, shared infra, multi-repo — see
	// HIGH_RISK_FLAGS in review/flags.ts). Gates the fast accept gesture: UI must require an
	// explicit confirmation, and the gesture route must reject an unconfirmed accept.
	requiresAcceptConfirmation: boolean;
}

export type GestureAction = "accept" | "defer" | "reject";
