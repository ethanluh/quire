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

// One entry per PR per criterion actually evaluated (mode "enforce" or "shadow"). Feeds
// Phase 0's keep-rate calculation: filter by criterionName/mode, count triggered vs total.
export interface GateLog {
	prId: string;
	criterionName: string;
	mode: GateMode;
	triggered: boolean;
	recordedAt: string;
}

// One entry per PR per cheap-screen run. Feeds Phase 0's drift base rate (fraction
// flagged) and concerns-per-member (signalCount distribution).
export interface ScreenLog {
	prId: string;
	bundleId: string;
	signalCount: number;
	flagged: boolean;
	recordedAt: string;
}

// Optional sink the pipeline reports to. Both methods are optional so instrumentation
// stays a pluggable add-on — same as LlmProvider/StaticAnalyzer — never a hard dependency
// for the pipeline to run.
export interface InstrumentationSink {
	recordGate?(entry: GateLog): Promise<void> | void;
	recordScreen?(entry: ScreenLog): Promise<void> | void;
}
