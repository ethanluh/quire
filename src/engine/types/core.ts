export interface SymbolRef {
	name: string;
	filePath: string;
	kind: "function" | "class" | "variable" | "type" | "export";
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

// Explicit "no direction was declared" label. Distinct from any real declaration so it
// can never collide with real text; recognized downstream (bundling, gate criteria) to
// force per-PR handling without ever inferring a direction from the diff (INV-1).
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
	diff: Diff;
	filesTouched: ReadonlyArray<string>;
	symbolsTouched: ReadonlyArray<SymbolRef>;
	testNamesChanged: ReadonlyArray<string>;
	ciStatus: "success" | "failure" | "pending" | "unknown";
}

export interface Bundle {
	id: string;
	direction: string;
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
	| { kind: "behavioralDelta"; prId: string; description: string; classified: "intended" | "unintended" };

export type DriftVerdict =
	| { status: "clean" }
	| { status: "flagged"; signals: ReadonlyArray<DriftSignal> };

export interface ReviewCard {
	bundleId: string;
	directionSummary: string;
	// Derived from the bundle's members (every ingestion run clusters PRs from a single
	// repo, see isBundleForRepo in server/refreshRepoQueue.ts) — lets the UI show/filter by
	// repo without fetching bundle detail.
	repoOwner: string;
	repoName: string;
	blastRadius: number;
	flags: ReadonlyArray<string>;
	drift: DriftVerdict;
	residualDisclosure: string;
	// Fingerprint of everything blastRadius/flags/drift are computed from (see
	// computeInputsHash in review/card.ts) — lets a later pipeline run prove those fields
	// are still valid without recomputing them, while directionSummary (declaredDirection
	// is metadata, not a drift-check input, INV-1) is always refreshed independent of this.
	inputsHash: string;
	memberCount: number;
	// True when `flags` includes a high-risk category (auth, shared infra, multi-repo — see
	// HIGH_RISK_FLAGS in review/flags.ts). Gates the fast accept gesture: UI must require an
	// explicit confirmation, and the gesture route must reject an unconfirmed accept.
	requiresAcceptConfirmation: boolean;
}

export type GestureAction = "accept" | "defer" | "reject";
