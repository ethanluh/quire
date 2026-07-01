import type { Bundle } from "../../engine/types/core.js";
import type { SkippedPullRequest } from "../../engine/github/client.js";
import type { GitHubClientHolder } from "../../engine/github/clientHolder.js";
import type { OAuthDeps } from "../../engine/github/oauth.js";
import { ensureValidAccessToken } from "../../engine/github/tokenRefresh.js";
import { rawPRPayloadToIncomingPR } from "../../engine/github/toIncomingPR.js";
import { normalizePR } from "../../engine/ingest/ingest.js";
import type { DecidedPrStore } from "../../engine/queue/decidedPrStore.js";
import type { AccountState } from "./accountState.js";
import { ingestIntoQueue } from "./ingestIntoQueue.js";
import type { IngestSummary, PipelineDeps } from "./ingestIntoQueue.js";
import type { ServerState } from "./state.js";

export { NeedsReconnectError } from "../../engine/github/tokenRefresh.js";

export interface RefreshDeps {
	accountState: AccountState;
	accountPath: string;
	clientHolder: GitHubClientHolder;
	oauth: OAuthDeps | undefined;
	decidedStore: DecidedPrStore;
	state: ServerState;
	pipelineDeps: PipelineDeps;
}

export interface RefreshRepoQueueResult extends IngestSummary {
	skipped: ReadonlyArray<SkippedPullRequest>;
}

function isBundleForRepo(bundle: Bundle, owner: string, name: string): boolean {
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
// reconciliation poll) goes through. Re-fetches and re-clusters the repo's full current
// (open, undecided) PR set on every call rather than just newly-changed PRs — bundling only
// clusters PRs within a single batch (see buildBundles/clusterPRs), so there's no way to
// join a new PR into an existing bundle without re-clustering the whole set.
export async function refreshRepoQueue(
	owner: string,
	name: string,
	deps: RefreshDeps,
): Promise<RefreshRepoQueueResult> {
	const account = deps.accountState.current;
	if (account === undefined) throw new Error("No connected account");

	deps.accountState.current = await ensureValidAccessToken(account, {
		accountPath: deps.accountPath,
		clientHolder: deps.clientHolder,
		oauth: deps.oauth,
	});

	const { payloads: rawPRs, skipped } = await deps.clientHolder.listOpenPullRequests(owner, name);
	const prs = rawPRs.map((raw) => normalizePR(rawPRPayloadToIncomingPR(raw)));
	const undecided = prs.filter((pr) => !deps.decidedStore.isDecided(pr.id));

	clearRepoFromQueue(deps.state, { owner, name });
	const summary = await ingestIntoQueue(undecided, deps.state, deps.pipelineDeps);
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
