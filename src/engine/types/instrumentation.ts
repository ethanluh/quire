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
