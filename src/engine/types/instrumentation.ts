import type { GateMode } from "./gate.js";

export interface DeferLog {
	bundleId: string;
	deferredAt: string;
	driftFlagged: boolean;
}

export interface HumanFinding {
	bundleId: string;
	recordedAt: string;
	riderFound: boolean;
	riderWasFlagged: boolean;
	notes: string;
}

// One row per (PR, criterion) evaluated by the gate — not just the criterion that
// ultimately decided the outcome — so Phase 0's keep-rate and per-criterion
// trigger-rate calculations can be computed directly from the log. The true
// false-positive rate additionally needs a human overturn decision, which this
// log alone does not capture (see docs/instrumentation.md, "Gate decisions").
export interface GateDecisionLog {
	prId: string;
	criterionName: string;
	mode: GateMode;
	triggered: boolean;
	recordedAt: string;
}

// One row per (bundle, member) cheap-screen run, feeding Phase 0's drift base
// rate and concerns-per-member distribution.
export interface DriftScreenLog {
	bundleId: string;
	prId: string;
	signalCount: number;
	flagged: boolean;
	recordedAt: string;
}

// Optional sink for pipeline-stage instrumentation. Every method is optional so
// logging never becomes a hard dependency for the pipeline to run — passing no
// sink (or a sink missing a method) is a silent no-op at each call site. Methods
// may return void or Promise<void>: callers always `await` the result, which is
// a no-op for a non-promise return, so sync and async implementations are both
// first-class rather than one being a workaround for the other.
export interface InstrumentationSink {
	logGateDecision?(entry: GateDecisionLog): Promise<void> | void;
	logDriftScreen?(entry: DriftScreenLog): Promise<void> | void;
}
