import type { Bundle, ReviewCard } from "../../engine/types/core.js";
import type { SkippedPullRequest } from "../../engine/github/client.js";
import type { GitHubClientHolder } from "../../engine/github/clientHolder.js";
import type { GitHubAppConfig } from "../../engine/github/installationClient.js";
import { InstallationRevokedError, isInstallationRevoked } from "../../engine/github/installationClient.js";
import { rawPRPayloadToIncomingPR } from "../../engine/github/toIncomingPR.js";
import { normalizePR } from "../../engine/ingest/ingest.js";
import type { DecidedPrStore } from "../../engine/queue/decidedPrStore.js";
import type { AccountState } from "./accountState.js";
import { ingestIntoQueue } from "./ingestIntoQueue.js";
import type { IngestSummary, PipelineDeps } from "./ingestIntoQueue.js";
import type { ServerState } from "./state.js";

export { InstallationRevokedError } from "../../engine/github/installationClient.js";

// Thrown when the bound installation changed (disconnected, rebound, or reselected)
// while a refresh was mid-flight — see the compare-and-swap in refreshRepoQueue below.
// Not a real failure: the binding itself is fine, this refresh cycle is just stale.
export class AccountChangedError extends Error {}

export interface RefreshDeps {
	accountState: AccountState;
	accountPath: string;
	preferencesPath: string;
	clientHolder: GitHubClientHolder;
	appConfig: GitHubAppConfig | undefined;
	decidedStore: DecidedPrStore;
	state: ServerState;
	pipelineDeps: PipelineDeps;
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
): Promise<RefreshRepoQueueResult> {
	const account = deps.accountState.current;
	if (account === undefined) throw new Error("No connected installation");

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
	// A disconnect (or rebind/reselect) racing this refresh's network round-trip would
	// otherwise silently proceed against a now-stale binding — bail instead.
	if (deps.accountState.current !== account) {
		throw new AccountChangedError("Installation binding changed mid-refresh; aborting this refresh");
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

	clearRepoFromQueue(deps.state, { owner, name });
	const summary = await ingestIntoQueue(undecided, deps.state, deps.pipelineDeps, {
		bundles: priorBundles,
		cards: priorCards,
	});
	return { ...summary, skipped };
}

// Serializes overlapping refresh calls for the same repo (a webhook burst, or a webhook
// racing the reconciliation poll) instead of letting them race on clearRepoFromQueue's and
// ingestIntoQueue's state mutations — see the concurrency note in refreshRepoQueue's design.
const inFlight = new Map<string, Promise<RefreshRepoQueueResult>>();

export function enqueueRefresh(owner: string, name: string, deps: RefreshDeps): Promise<RefreshRepoQueueResult> {
	const key = `${owner}/${name}`;
	const previous = inFlight.get(key) ?? Promise.resolve();
	const run = previous
		.catch(() => undefined)
		.then(() => refreshRepoQueue(owner, name, deps));
	inFlight.set(key, run);
	run.finally(() => {
		if (inFlight.get(key) === run) inFlight.delete(key);
	}).catch(() => undefined);
	return run;
}
