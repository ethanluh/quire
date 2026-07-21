import type { Bundle, ReviewCard } from "../../engine/types/core.js";
import type { SkippedPullRequest } from "../../engine/github/client.js";
import type { GitHubClientHolder } from "../../engine/github/clientHolder.js";
import type { GitHubAppConfig } from "../../engine/github/installationClient.js";
import { InstallationRevokedError, isInstallationRevoked } from "../../engine/github/installationClient.js";
import { rawPRPayloadToIncomingPR } from "../../engine/github/toIncomingPR.js";
import { normalizePR } from "../../engine/ingest/ingest.js";
import type { DecidedPrStore } from "../../engine/queue/decidedPrStore.js";
import type { MergeQueue } from "../../engine/queue/mergeQueue.js";
import type { AccountState } from "./accountState.js";
import { installationForRepo } from "./accountState.js";
import { notifyStateChanged } from "./changeEvents.js";
import { createKeyedLock } from "../../engine/util/keyedLock.js";
import { withTimeout } from "../../engine/util/timeout.js";
import { errorMessage } from "../../engine/util/error.js";
import { ingestIntoQueue, StaleIngestError } from "./ingestIntoQueue.js";
import type { IngestSummary, PipelineDeps } from "./ingestIntoQueue.js";
import type { ServerState } from "./state.js";

export { InstallationRevokedError } from "../../engine/github/installationClient.js";

// Thrown when the bound installation changed (disconnected, rebound, or reselected)
// while a refresh was mid-flight — see the compare-and-swap in refreshRepoQueue below.
// Not a real failure: the binding itself is fine, this refresh cycle is just stale.
export class AccountChangedError extends Error {}

// Thrown when a single refresh (a GitHub rate-limit stall, most commonly) runs past
// REFRESH_TIMEOUT_MS — without this, enqueueRefresh's coalescing lock never released, so a
// single wedged refresh silently stranded every later refresh for that repo behind it.
export class RefreshTimeoutError extends Error {}

// Thrown (internally, never surfaced to a caller — see enqueueRefresh) when a refresh that
// already missed its deadline finally resolves after a newer refresh for the same repo has
// started. withTimeout only bounds how long enqueueRefresh's *caller* waits; the abandoned
// call keeps running underneath and would otherwise still reach clearRepoFromQueue/
// ingestIntoQueue and clobber whatever the newer, already-completed refresh wrote — exactly
// the race the coalescing lock exists to prevent. Discarding here closes that gap.
export class StaleRefreshError extends Error {}

const REFRESH_TIMEOUT_MS = 30_000;

export interface RefreshDeps {
	accountState: AccountState;
	accountPath: string;
	clientHolder: GitHubClientHolder;
	appConfig: GitHubAppConfig | undefined;
	decidedStore: DecidedPrStore;
	state: ServerState;
	pipelineDeps: PipelineDeps;
	// Lets a webhook-triggered refresh also pick a stuck merge back up (see webhook.ts's
	// synchronize handling) — not used by refreshRepoQueue/enqueueRefresh themselves.
	queue: MergeQueue;
	// Scopes enqueueRefresh's per-repo coalescing lock to this tenant (its GitHub login) —
	// omitted defaults to the pre-multi-tenant behavior of one shared lock namespace, which
	// existing single-tenant callers/tests still rely on.
	tenantKey?: string;
	// Overrides REFRESH_TIMEOUT_MS — exists so tests can force a timeout deterministically
	// without waiting out the real 30s budget.
	refreshTimeoutMs?: number;
}

export interface RefreshRepoQueueResult extends IngestSummary {
	skipped: ReadonlyArray<SkippedPullRequest>;
}

export function isBundleForRepo(bundle: Bundle, owner: string, name: string): boolean {
	return bundle.members.length > 0 && bundle.members.every((m) => m.repoOwner === owner && m.repoName === name);
}

// Drops any bundle/card whose members all belong to `repo` — used before re-populating a
// repo's queue so entries get replaced rather than accumulated (re-refreshing the same
// repo, or switching away from a previously selected one, both leave stale entries
// otherwise).
export function clearRepoFromQueue(state: ServerState, repo: { owner: string; name: string } | undefined): void {
	if (repo === undefined) return;
	for (const [id, bundle] of state.bundles) {
		if (isBundleForRepo(bundle, repo.owner, repo.name)) {
			state.bundles.delete(id);
			state.cards.delete(id);
		}
	}
}

// The single funnel every ingestion trigger (manual /repos/select, a GitHub webhook, or the
// reconciliation poll) goes through. Re-fetches the repo's full current (open, undecided) PR
// set on every call, but re-clustering/re-screening is incremental: bundles from the previous
// run are captured below (before clearRepoFromQueue wipes them) and handed to ingestIntoQueue
// as seeds, so only new/changed PRs and the bundles they touch redo real work.
export async function refreshRepoQueue(
	owner: string,
	name: string,
	deps: RefreshDeps,
	isSuperseded?: () => boolean,
): Promise<RefreshRepoQueueResult> {
	const activeAtStart = installationForRepo(deps.accountState.current, owner, name);
	if (activeAtStart === undefined) throw new Error(`No connected installation backs ${owner}/${name}`);

	let rawPRs, skipped;
	try {
		({ payloads: rawPRs, skipped } = await deps.clientHolder.listOpenPullRequests(owner, name));
	} catch (err) {
		if (isInstallationRevoked(err)) {
			throw new InstallationRevokedError(
				`Installation lost access to ${owner}/${name}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		throw err;
	}
	// A disconnect (or repo/installation change) racing this refresh's network round-trip
	// would otherwise silently proceed against a now-stale binding — bail instead. Compared
	// by identity (installationForRepo), not object reference: with multiple watched repos,
	// an unrelated one being added/removed/rebound mid-flight must NOT abort this refresh.
	if (installationForRepo(deps.accountState.current, owner, name)?.installationId !== activeAtStart.installationId) {
		throw new AccountChangedError("Installation binding changed mid-refresh; aborting this refresh");
	}
	// A cheap early exit — isSuperseded is undefined for direct callers (tests, no coalescing
	// involved); enqueueRefresh is the only caller that passes one. This check alone isn't
	// sufficient (ingestIntoQueue below can itself run long on LLM-backed extraction, well
	// past this point) — see the guard passed into ingestIntoQueue, which is the one that
	// actually gates the state write.
	if (isSuperseded?.() === true) {
		throw new StaleRefreshError(`Refresh of ${owner}/${name} superseded by a newer refresh; discarding stale result`);
	}

	const prs = rawPRs.map((raw) => normalizePR(rawPRPayloadToIncomingPR(raw)));
	const undecided = prs.filter((pr) => !deps.decidedStore.isDecided(pr.id));

	await deps.pipelineDeps.prCache.evictStaleForRepo(owner, name, new Set(prs.map((pr) => pr.id)));

	const priorBundles = [...deps.state.bundles.values()].filter((b) => isBundleForRepo(b, owner, name));
	const priorCards = new Map<string, ReviewCard>();
	for (const bundle of priorBundles) {
		const card = deps.state.cards.get(bundle.id);
		if (card !== undefined) priorCards.set(bundle.id, card);
	}

	// clearRepoFromQueue is itself synchronous and immediately followed by ingestIntoQueue's
	// own pre-commit guard (same isSuperseded, re-checked there since orchestratePipeline's
	// LLM-backed work below can take long enough for a newer refresh to finish first) — so
	// re-checking here too would only guard the (comparatively instant) gap since the last
	// check, not the real risk window.
	if (isSuperseded?.() === true) {
		throw new StaleRefreshError(`Refresh of ${owner}/${name} superseded by a newer refresh; discarding stale result`);
	}
	clearRepoFromQueue(deps.state, { owner, name });
	const summary = await ingestIntoQueue(
		undecided,
		deps.state,
		deps.pipelineDeps,
		{ bundles: priorBundles, cards: priorCards },
		isSuperseded,
	);
	return { ...summary, skipped };
}

// Serializes overlapping refresh calls for the same repo (a webhook burst, or a webhook
// racing the reconciliation poll) instead of letting them race on clearRepoFromQueue's and
// ingestIntoQueue's state mutations — see the concurrency note in refreshRepoQueue's design.
// Keyed by tenant too: two different tenants independently selecting the same owner/name
// must never coalesce onto each other's refresh. Uses the shared createKeyedLock
// (util/keyedLock.ts); the notifyStateChanged post-step stays *inside* the locked callback so
// it remains part of the same serialized region (and runs before the lock's own delete
// guard) exactly as it did when this was a hand-rolled promise chain.
const refreshLock = createKeyedLock();

// The most recent attempt's identity for each lock key — lets a call that's still running
// after its own timeout fired (see REFRESH_TIMEOUT_MS) recognize, once it finally resolves,
// that a newer call already took its place and it must not touch deps.state. A plain
// per-key counter would work just as well; a symbol just makes "am I still current" an
// identity check instead of a comparison that could be fooled by wraparound.
const activeAttempts = new Map<string, symbol>();

export function enqueueRefresh(owner: string, name: string, deps: RefreshDeps): Promise<RefreshRepoQueueResult> {
	const key = `${deps.tenantKey ?? ""}:${owner}/${name}`;
	return refreshLock(key, async () => {
		const attempt = Symbol(key);
		activeAttempts.set(key, attempt);
		const timeoutMs = deps.refreshTimeoutMs ?? REFRESH_TIMEOUT_MS;
		const inFlight = refreshRepoQueue(owner, name, deps, () => activeAttempts.get(key) !== attempt);
		// withTimeout's race already attaches its own handler to `inFlight`, so this second
		// subscription doesn't affect that race or risk an unhandled rejection — it only logs
		// whatever the abandoned call eventually settles with, since nothing else observes it
		// once the race below has already moved on without it.
		inFlight.catch((err: unknown) => {
			if (err instanceof StaleRefreshError || err instanceof StaleIngestError) {
				console.warn(err.message);
				return;
			}
			console.error(`Refresh of ${owner}/${name} settled after its timeout was already reported to the caller: ${errorMessage(err)}`);
		});
		const result = await withTimeout(
			inFlight,
			timeoutMs,
			() => new RefreshTimeoutError(`Refresh of ${owner}/${name} exceeded ${timeoutMs}ms`),
		);
		// Only reclaim the map entry on a normal (non-timed-out) completion: withTimeout throws
		// before reaching this line otherwise, which is exactly when a later, still-abandoned
		// resolution needs `activeAttempts.get(key) !== attempt` to keep reading true.
		if (activeAttempts.get(key) === attempt) activeAttempts.delete(key);
		// Single choke point for both the webhook route and the reconciliation timer —
		// tells this tenant's open SSE connections to re-fetch instead of waiting for their
		// next poll tick. Falls back to "" to match the lock key above for callers that omit
		// tenantKey (pre-multi-tenant tests).
		notifyStateChanged(deps.tenantKey ?? "");
		return result;
	});
}
