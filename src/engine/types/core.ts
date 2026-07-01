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

export interface PullRequest {
	id: string;
	repoOwner: string;
	repoName: string;
	number: number;
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
}

export interface Effect {
	clause: string;
	matchedDirection: boolean;
}

export type DriftSignal =
	| { kind: "effectList"; orphanClauses: ReadonlyArray<string> }
	| { kind: "footprintAnomaly"; surprisingSymbols: ReadonlyArray<SymbolRef> }
	| { kind: "behavioralDelta"; description: string; classified: "intended" | "unintended" };

export type DriftVerdict =
	| { status: "clean" }
	| { status: "flagged"; signals: ReadonlyArray<DriftSignal> };

export interface ReviewCard {
	bundleId: string;
	directionSummary: string;
	blastRadius: number;
	flags: ReadonlyArray<string>;
	drift: DriftVerdict;
	residualDisclosure: string;
}

export type GestureAction = "accept" | "defer" | "reject";
