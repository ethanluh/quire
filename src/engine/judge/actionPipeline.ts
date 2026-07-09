import type { Bundle, ReviewCard } from "../types/core.js";
import type { JudgeActionRecord, JudgeVerdict, PendingMemberVerification } from "../types/judge.js";
import type { GitHubClient } from "../github/client.js";
import type { MergeQueue } from "../queue/mergeQueue.js";
import type { MergeQueueEntry } from "../types/queue.js";
import type { DecidedPrStore } from "../queue/decidedPrStore.js";
import type { JudgeActionStore } from "./judgeActionStore.js";
import type { SlackLink, SlackNotifier } from "../../interface/notify/slack.js";
import { ciOutcomeFromCheckSuiteConclusion, performHealthCheck } from "./verify.js";
import { errorMessage } from "../util/error.js";

// Synthetic login attributing an autonomous judge action in decided-prs.json and the review-
// card comment posted to each member PR — distinguishable at a glance from any real GitHub
// login (which can never contain a space), same spirit as UNDECLARED_DIRECTION's sentinel.
export const JUDGE_ACTOR = "bundle judge (auto)";

export interface ActionPipelineDeps {
	queue: MergeQueue;
	actionStore: JudgeActionStore;
	slack: SlackNotifier;
	github: GitHubClient;
	decidedStore: DecidedPrStore;
	// Narrow references into ServerState, not the whole state object — mirrors how MergeQueue
	// itself only ever receives what it needs (see tenant.ts's construction), and keeps this
	// module free of a dependency on the interface layer's ServerState type.
	bundles: Map<string, Bundle>;
	cards: Map<string, ReviewCard>;
	verifyTimeoutMs: number;
	healthCheckUrl?: string;
}

function memberLinks(bundle: Bundle): ReadonlyArray<SlackLink> {
	return bundle.members.map((m) => ({
		label: `${m.repoOwner}/${m.repoName}#${m.number}`,
		url: `https://github.com/${m.repoOwner}/${m.repoName}/pull/${m.number}`,
	}));
}

async function postReviewCardToMembers(github: GitHubClient, action: "accept" | "reject", bundle: Bundle, card: ReviewCard): Promise<void> {
	for (const pr of bundle.members) {
		try {
			await github.postReviewCardComment(pr.repoOwner, pr.repoName, pr.number, action, card);
		} catch (err) {
			console.error(`Bundle judge: failed to post review-card comment to ${pr.repoOwner}/${pr.repoName}#${pr.number} (ignored):`, err);
		}
	}
}

async function escalate(record: Omit<JudgeActionRecord, "status" | "updatedAt" | "terminalReason">, reason: string, deps: ActionPipelineDeps): Promise<void> {
	const updatedAt = new Date().toISOString();
	await deps.actionStore.save({ ...record, status: "escalated", updatedAt, terminalReason: reason });
	await deps.slack.notifyEscalation({
		bundleId: record.bundleId,
		directionSummary: record.directionSummary,
		reason,
		rationale: record.rationale,
		links: [],
	});
}

async function attemptAutoReject(bundle: Bundle, card: ReviewCard, verdict: JudgeVerdict, deps: ActionPipelineDeps): Promise<void> {
	const startedAt = new Date().toISOString();
	const base = {
		bundleId: bundle.id,
		inputsHash: card.inputsHash,
		gesture: "reject" as const,
		directionSummary: bundle.direction,
		rationale: verdict.rationale,
		startedAt,
	};
	await deps.actionStore.save({ ...base, status: "rejecting", updatedAt: startedAt });

	// Close each member PR on GitHub before touching local state — same ordering gestures.ts's
	// human reject uses, so a GitHub-side failure leaves the bundle for retry instead of the
	// verdict being silently lost while the PR stays open.
	for (const pr of bundle.members) {
		await deps.github.closePullRequest(pr.repoOwner, pr.repoName, pr.number);
	}
	await deps.queue.enqueueClosed(bundle, card);
	await deps.decidedStore.markDecided(bundle.members.map((m) => m.id), "reject", { decidedBy: JUDGE_ACTOR, bundleId: bundle.id });
	deps.bundles.delete(bundle.id);
	deps.cards.delete(bundle.id);
	await postReviewCardToMembers(deps.github, "reject", bundle, card);

	await deps.actionStore.save({ ...base, status: "rejected", updatedAt: new Date().toISOString() });
	await deps.slack.notifyOutcome({
		kind: "auto-rejected",
		bundleId: bundle.id,
		directionSummary: bundle.direction,
		rationale: verdict.rationale,
		links: memberLinks(bundle),
	});
}

// Enqueues, then drains the FIFO queue until either this exact bundle resolves or the queue
// empties — bounded by the number of entries that were actually waiting to be processed at
// the moment we started, so this can never loop forever. A human's own autoMergeOnAccept
// trigger only ever makes ONE dequeueNext() call and accepts that it might not be this
// specific bundle's turn yet (a human can just click Process again) — the judge needs to
// know the real outcome before it can proceed to VERIFY, so it drains deterministically
// instead. AUTO-FIX (bounded): the existing self-heal (semanticHunkResolver, via
// MergeQueue's own ensureMergeable/attemptResolution) already runs as an ordinary part of
// this same drain — there is no separate conflict-handling step here to build.
async function driveToCompletion(bundleId: string, deps: ActionPipelineDeps): Promise<MergeQueueEntry | undefined> {
	const bound = deps.queue.snapshot().entries.filter((e) => e.status === "queued" || e.status === "landing").length;
	let entry: MergeQueueEntry | undefined;
	for (let i = 0; i < bound; i++) {
		entry = await deps.queue.dequeueNext();
		if (entry === undefined || entry.bundleId === bundleId) break;
	}
	return entry;
}

async function attemptAutoAccept(bundle: Bundle, card: ReviewCard, verdict: JudgeVerdict, deps: ActionPipelineDeps): Promise<void> {
	const startedAt = new Date().toISOString();
	const base = {
		bundleId: bundle.id,
		inputsHash: card.inputsHash,
		gesture: "accept" as const,
		directionSummary: bundle.direction,
		rationale: verdict.rationale,
		startedAt,
	};
	await deps.actionStore.save({ ...base, status: "merging", updatedAt: startedAt });

	// Same queue.enqueue() a human accept uses (INV-5: reversible until landed) — removing
	// the bundle from the review queue mirrors gestures.ts's accept branch exactly.
	await deps.queue.enqueue(bundle, card);
	deps.bundles.delete(bundle.id);
	deps.cards.delete(bundle.id);

	const entry = await driveToCompletion(bundle.id, deps);

	if (entry === undefined || entry.bundleId !== bundle.id) {
		await escalate(base, "the merge queue did not reach this bundle within the drain bound — left queued for normal processing", deps);
		return;
	}

	if (entry.status !== "landed") {
		const reason =
			entry.conflict !== undefined
				? `merge did not land (status: ${entry.status}): ${entry.conflict.reason}`
				: `merge did not land (status: ${entry.status})`;
		await escalate(base, reason, deps);
		return;
	}

	const members: PendingMemberVerification[] = (entry.mergedShas ?? []).flatMap((m) => {
		const pr = bundle.members.find((member) => member.id === m.prId);
		if (pr === undefined) return [];
		return [{ prId: m.prId, repoOwner: pr.repoOwner, repoName: pr.repoName, number: pr.number, sha: m.sha }];
	});

	if (members.length === 0) {
		// Every member landed via the "alreadyMerged" path — no fresh SHA was captured for
		// any of them, so there is nothing to match a check_suite against. Escalate rather
		// than silently declaring victory: "nothing to verify" must never read as "verified".
		await escalate(
			base,
			"bundle landed but no merge-commit SHA was captured for any member — cannot verify, escalating rather than assuming success",
			deps,
		);
		return;
	}

	const verifyDeadline = new Date(Date.now() + deps.verifyTimeoutMs).toISOString();
	await deps.actionStore.save({ ...base, status: "awaitingVerification", updatedAt: new Date().toISOString(), members, verifyDeadline });
}

// The single entry point called from orchestrate.ts once the gate has allowed an accept or
// reject in "auto" mode. Idempotent by (bundleId, inputsHash): a record already existing for
// this exact bundle content — in any status, terminal or not — means an action was already
// attempted, so this never merges or rejects the same bundle content twice.
export async function attemptAutoAction(bundle: Bundle, card: ReviewCard, verdict: JudgeVerdict, deps: ActionPipelineDeps): Promise<void> {
	if (deps.actionStore.find(bundle.id, card.inputsHash) !== undefined) return;

	if (verdict.gesture === "accept") {
		await attemptAutoAccept(bundle, card, verdict, deps);
	} else if (verdict.gesture === "reject") {
		await attemptAutoReject(bundle, card, verdict, deps);
	}
	// "defer" never reaches here — gate.ts refuses to allow it under any circumstances.
}

async function finalizeAsReverted(record: JudgeActionRecord, members: ReadonlyArray<PendingMemberVerification>, reason: string, deps: ActionPipelineDeps): Promise<void> {
	const revertedUrls: string[] = [];
	for (const member of members) {
		try {
			const url = await deps.queue.revertPr(record.bundleId, member.prId);
			revertedUrls.push(url);
		} catch (err) {
			// A revert failing for one member must not stop the others — surface every
			// failure in the escalation reason rather than losing it (INV-6).
			console.error(`Bundle judge: revertPr failed for ${record.bundleId}/${member.prId} (continuing with other members):`, errorMessage(err));
		}
	}

	const updatedAt = new Date().toISOString();
	const fullReason = `${reason} — reverted ${revertedUrls.length}/${members.length} member(s)`;
	await deps.actionStore.save({ ...record, status: "reverted", members, updatedAt, terminalReason: fullReason });
	await deps.slack.notifyOutcome({
		kind: "reverted",
		bundleId: record.bundleId,
		directionSummary: record.directionSummary,
		rationale: fullReason,
		links: revertedUrls.map((url, i) => ({ label: `revert ${i + 1}`, url })),
	});
	// A revert is also an escalation-worthy event (something the judge auto-merged had to be
	// undone) — send both notifications so a human sees it whether they watch the outcomes
	// channel, the escalations channel, or both.
	await deps.slack.notifyEscalation({
		bundleId: record.bundleId,
		directionSummary: record.directionSummary,
		reason: fullReason,
		rationale: record.rationale,
		links: [],
	});
}

async function finalizeAsInconclusive(record: JudgeActionRecord, members: ReadonlyArray<PendingMemberVerification>, reason: string, deps: ActionPipelineDeps): Promise<void> {
	// Deliberately the "escalated" status, not a new one — inconclusive verification and a
	// merge that never landed both end up in the same place: a human sees it, nothing was
	// auto-declared successful, and nothing was reverted over ambiguous evidence.
	await deps.actionStore.save({ ...record, status: "escalated", members, updatedAt: new Date().toISOString(), terminalReason: reason });
	await deps.slack.notifyEscalation({
		bundleId: record.bundleId,
		directionSummary: record.directionSummary,
		reason,
		rationale: record.rationale,
		links: [],
	});
}

async function finalizeAsVerified(record: JudgeActionRecord, members: ReadonlyArray<PendingMemberVerification>, deps: ActionPipelineDeps): Promise<void> {
	await deps.actionStore.save({ ...record, status: "verified", members, updatedAt: new Date().toISOString() });
	await deps.slack.notifyOutcome({
		kind: "auto-merged-and-verified",
		bundleId: record.bundleId,
		directionSummary: record.directionSummary,
		rationale: record.rationale,
		links: members.map((m) => ({ label: `${m.repoOwner}/${m.repoName}#${m.number}`, url: `https://github.com/${m.repoOwner}/${m.repoName}/commit/${m.sha}` })),
	});
}

// CI passed for every member — the last gate before declaring success. Read-only: a single
// GET against a configured URL, never a command (see docs/judge-integration-map.md §7).
async function runOptionalHealthCheck(
	record: JudgeActionRecord,
	members: ReadonlyArray<PendingMemberVerification>,
	deps: ActionPipelineDeps,
): Promise<void> {
	if (deps.healthCheckUrl === undefined) {
		await finalizeAsVerified(record, members, deps);
		return;
	}
	const outcome = await performHealthCheck({ url: deps.healthCheckUrl });
	if (outcome === "healthy") {
		await finalizeAsVerified(record, members, deps);
	} else if (outcome === "unhealthy") {
		await finalizeAsReverted(record, members, "post-deploy health check reported unhealthy", deps);
	} else {
		await finalizeAsInconclusive(record, members, "post-deploy health check was unreachable within the timeout — inconclusive, not treated as failure or success", deps);
	}
}

// Called once every member's CI outcome is known (all "success", or at least one
// "failure") — see resolveCheckSuiteForMember below, the only caller.
async function finalizeVerification(record: JudgeActionRecord, members: ReadonlyArray<PendingMemberVerification>, deps: ActionPipelineDeps): Promise<void> {
	const anyFailed = members.some((m) => m.outcome === "failure");
	if (anyFailed) {
		await finalizeAsReverted(record, members, "one or more member commits failed CI verification", deps);
		return;
	}
	await runOptionalHealthCheck(record, members, deps);
}

async function resolveCheckSuiteForMember(
	record: JudgeActionRecord,
	prId: string,
	outcome: "success" | "failure",
	deps: ActionPipelineDeps,
): Promise<void> {
	// Re-read the freshest persisted copy rather than trusting the caller's snapshot — two
	// check_suite deliveries for two different members of the same bundle can arrive close
	// together, and JudgeActionStore.save() serializes writes but a caller could still be
	// holding a stale `record` read before this function started.
	const current = deps.actionStore.find(record.bundleId, record.inputsHash);
	if (current === undefined || current.status !== "awaitingVerification" || current.members === undefined) return;

	const updatedMembers = current.members.map((m) => (m.prId === prId && m.outcome === undefined ? { ...m, outcome } : m));
	await deps.actionStore.save({ ...current, members: updatedMembers, updatedAt: new Date().toISOString() });

	if (updatedMembers.some((m) => m.outcome === undefined)) return; // still waiting on other members
	await finalizeVerification(current, updatedMembers, deps);
}

// Called from the webhook route's check_suite handler (additively, alongside the existing
// PR-id-keyed self-heal branch) for every tenant with at least one bundle
// "awaitingVerification". A no-op if nothing matches this (repoOwner, repoName, sha) —
// cheap enough to call unconditionally on every completed check_suite delivery.
export async function handleCheckSuiteForVerification(
	repoOwner: string,
	repoName: string,
	headSha: string,
	conclusion: string | undefined,
	deps: ActionPipelineDeps,
): Promise<void> {
	const outcome = ciOutcomeFromCheckSuiteConclusion(conclusion);
	if (outcome === "inconclusive") return; // still in progress, or an ambiguous conclusion — the timeout sweep is the backstop, not this delivery.

	for (const record of deps.actionStore.listAwaitingVerification()) {
		const member = record.members?.find((m) => m.repoOwner === repoOwner && m.repoName === repoName && m.sha === headSha && m.outcome === undefined);
		if (member === undefined) continue;
		await resolveCheckSuiteForMember(record, member.prId, outcome, deps);
	}
}

// Periodic sweep (mirrors MergeQueue.pollInvestigations' setInterval pattern) for bundles
// whose verifyDeadline has passed without every member resolving — the backstop for a missed
// or never-configured webhook. Never treats a timeout as success; always escalates instead.
export async function sweepExpiredVerifications(deps: ActionPipelineDeps): Promise<void> {
	const now = Date.now();
	for (const record of deps.actionStore.listAwaitingVerification()) {
		if (record.verifyDeadline === undefined || new Date(record.verifyDeadline).getTime() > now) continue;
		const members = record.members ?? [];
		await finalizeAsInconclusive(
			record,
			members,
			"verification did not complete within the timeout window — inconclusive, not treated as failure or success",
			deps,
		);
	}
}
