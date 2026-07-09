import { describe, it, expect } from "@jest/globals";
import { retrievePrecedent } from "../../src/engine/judge/precedent.js";
import type { Bundle, PullRequest, ReviewCard } from "../../src/engine/types/core.js";
import type { QueueState, MergeQueueEntry } from "../../src/engine/types/queue.js";
import type { ShelfState } from "../../src/engine/types/shelf.js";
import type { DecidedPrEntry } from "../../src/engine/types/decided.js";

function makePr(overrides: Partial<PullRequest> = {}): PullRequest {
	return {
		id: "pr-1",
		repoOwner: "org",
		repoName: "repo",
		number: 1,
		headSha: "sha-1",
		declaredDirection: "add passwordless auth",
		directionInferred: false,
		diff: { raw: "", hunks: [] },
		filesTouched: [],
		symbolsTouched: [],
		testNamesChanged: [],
		ciStatus: "success",
		...overrides,
	};
}

function makeBundle(overrides: Partial<Bundle> = {}): Bundle {
	return {
		id: "bundle-1",
		direction: "add passwordless auth",
		directionInferred: false,
		effectSummary: "adds OTP based login to the settings page",
		members: [makePr()],
		...overrides,
	};
}

function makeCard(bundleId: string): ReviewCard {
	return {
		bundleId,
		directionSummary: "x",
		directionInferred: false,
		repoOwner: "org",
		repoName: "repo",
		blastRadius: 1,
		flags: [],
		drift: { status: "clean" },
		residualDisclosure: "x",
		specConformance: { status: "clean" },
		specConformanceDisclosure: "",
		inputsHash: "hash",
		memberCount: 1,
		requiresAcceptConfirmation: false,
	};
}

function makeQueueEntry(overrides: Partial<MergeQueueEntry> & { bundle: Bundle }): MergeQueueEntry {
	return {
		bundleId: overrides.bundle.id,
		enqueuedAt: "2026-01-01T00:00:00.000Z",
		status: "landed",
		revertedPrIds: [],
		mergedPrIds: [],
		card: makeCard(overrides.bundle.id),
		...overrides,
	};
}

function makeDecided(bundleId: string, action: DecidedPrEntry["action"]): DecidedPrEntry {
	return { prId: `${bundleId}-pr`, action, decidedAt: "2026-01-01T00:00:00.000Z", decidedBy: "alice", bundleId };
}

describe("retrievePrecedent", () => {
	it("ranks a landed bundle with an overlapping effect summary above an unrelated one", () => {
		const candidate = makeBundle({ id: "candidate", effectSummary: "adds OTP based login to the settings page" });
		const close = makeBundle({ id: "close", effectSummary: "adds OTP based login flow to account settings" });
		const far = makeBundle({ id: "far", effectSummary: "rewrites the CSS build pipeline" });
		const queueState: QueueState = {
			entries: [makeQueueEntry({ bundle: close, status: "landed" }), makeQueueEntry({ bundle: far, status: "landed" })],
		};
		const shelfState: ShelfState = { entries: [] };
		const decided = [makeDecided("close", "accept"), makeDecided("far", "accept")];

		const result = retrievePrecedent(candidate, queueState, shelfState, decided);
		expect(result[0]?.bundleId).toBe("close");
		expect(result.some((p) => p.bundleId === "far")).toBe(false);
	});

	it("labels a landed bundle as accept and a closed bundle as reject", () => {
		const candidate = makeBundle({ id: "candidate", effectSummary: "adds dark mode toggle" });
		const landed = makeBundle({ id: "landed-1", effectSummary: "adds dark mode support to settings" });
		const closed = makeBundle({ id: "closed-1", effectSummary: "adds dark mode override to settings" });
		const queueState: QueueState = {
			entries: [makeQueueEntry({ bundle: landed, status: "landed" }), makeQueueEntry({ bundle: closed, status: "closed" })],
		};
		const shelfState: ShelfState = { entries: [] };
		const decided = [makeDecided("landed-1", "accept"), makeDecided("closed-1", "reject")];

		const result = retrievePrecedent(candidate, queueState, shelfState, decided);
		expect(result.find((p) => p.bundleId === "landed-1")?.gesture).toBe("accept");
		expect(result.find((p) => p.bundleId === "closed-1")?.gesture).toBe("reject");
	});

	it("labels a reverted bundle as accept (it was a human accept that was later undone, not a reject)", () => {
		const candidate = makeBundle({ id: "candidate", effectSummary: "adds dark mode toggle" });
		const reverted = makeBundle({ id: "reverted-1", effectSummary: "adds dark mode support to settings" });
		const queueState: QueueState = { entries: [makeQueueEntry({ bundle: reverted, status: "reverted" })] };
		const decided = [makeDecided("reverted-1", "accept")];

		const result = retrievePrecedent(candidate, queueState, { entries: [] }, decided);
		expect(result.find((p) => p.bundleId === "reverted-1")?.gesture).toBe("accept");
	});

	it("excludes a closed bundle with no confirming decided-PR record (an external close, not a human reject)", () => {
		const candidate = makeBundle({ id: "candidate", effectSummary: "adds dark mode toggle" });
		const closed = makeBundle({ id: "closed-1", effectSummary: "adds dark mode support to settings" });
		const queueState: QueueState = { entries: [makeQueueEntry({ bundle: closed, status: "closed" })] };

		const result = retrievePrecedent(candidate, queueState, { entries: [] }, []);
		expect(result).toEqual([]);
	});

	it("includes deferred bundles from the shelf, confirmed by a decided defer record", () => {
		const candidate = makeBundle({ id: "candidate", effectSummary: "adds dark mode toggle" });
		const deferred = makeBundle({ id: "deferred-1", effectSummary: "adds dark mode support to settings" });
		const shelfState: ShelfState = { entries: [{ bundleId: "deferred-1", card: makeCard("deferred-1"), bundle: deferred, memberPrIds: ["pr-1"] }] };
		const decided = [makeDecided("deferred-1", "defer")];

		const result = retrievePrecedent(candidate, { entries: [] }, shelfState, decided);
		expect(result.find((p) => p.bundleId === "deferred-1")?.gesture).toBe("defer");
	});

	it("excludes the candidate bundle itself even if it somehow already appears in queue history", () => {
		const candidate = makeBundle({ id: "candidate", effectSummary: "adds dark mode toggle" });
		const queueState: QueueState = { entries: [makeQueueEntry({ bundle: candidate, status: "landed" })] };
		const decided = [makeDecided("candidate", "accept")];

		expect(retrievePrecedent(candidate, queueState, { entries: [] }, decided)).toEqual([]);
	});

	it("returns an empty array when nothing overlaps at all", () => {
		const candidate = makeBundle({ id: "candidate", effectSummary: "adds dark mode toggle" });
		const unrelated = makeBundle({ id: "unrelated-1", effectSummary: "rewrites the CSS build pipeline" });
		const queueState: QueueState = { entries: [makeQueueEntry({ bundle: unrelated, status: "landed" })] };
		const decided = [makeDecided("unrelated-1", "accept")];

		expect(retrievePrecedent(candidate, queueState, { entries: [] }, decided)).toEqual([]);
	});

	it("caps results at the given limit", () => {
		const candidate = makeBundle({ id: "candidate", effectSummary: "adds OTP login to settings" });
		const entries: MergeQueueEntry[] = [];
		const decided: DecidedPrEntry[] = [];
		for (let i = 0; i < 10; i++) {
			const bundle = makeBundle({ id: `bundle-${i}`, effectSummary: "adds OTP login to settings page" });
			entries.push(makeQueueEntry({ bundle, status: "landed" }));
			decided.push(makeDecided(`bundle-${i}`, "accept"));
		}
		const result = retrievePrecedent(candidate, { entries }, { entries: [] }, decided, 3);
		expect(result).toHaveLength(3);
	});
});
