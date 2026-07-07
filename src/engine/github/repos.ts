import type { Octokit } from "@octokit/rest";
import { isHttpError } from "./octokitClient.js";

export interface RepoSummary {
	owner: string;
	name: string;
	fullName: string;
	private: boolean;
	defaultBranch: string;
	// Which bound installation this repo came from, and that installation's display login —
	// needed once the picker can show repos merged from more than one installation, so the
	// UI can disambiguate (and the client can report back which installation a selection
	// came from). Denormalized here rather than joined in the UI: cheap (no extra API call),
	// since the caller already knows both when it builds this list.
	installationId: number;
	accountLogin: string;
	starred: boolean;
	pinned: boolean;
}

// GET /installation/repositories — the repos this specific installation was granted, not
// the connecting user's full repo list (which `listForAuthenticatedUser` returned under
// the old OAuth-token model, and which has no meaning for an installation-authenticated
// client — there is no "authenticated user" to list repos for). Archived repos are
// dropped. starred/pinned default to false here; enrichWithStarredAndPinned fills them in
// separately using a user-authenticated client, since an installation client has no
// "viewer" of its own.
export async function listInstallationRepositories(
	octokit: Octokit,
	installationId: number,
	accountLogin: string,
): Promise<ReadonlyArray<RepoSummary>> {
	const repos = await octokit.paginate(octokit.rest.apps.listReposAccessibleToInstallation, { per_page: 100 });
	return repos
		.filter((r) => !r.archived)
		.map((r) => ({
			owner: r.owner.login,
			name: r.name,
			fullName: r.full_name,
			private: r.private,
			defaultBranch: r.default_branch,
			installationId,
			accountLogin,
			starred: false,
			pinned: false,
		}));
}

interface PinnedItemsResponse {
	viewer: {
		pinnedItems: {
			nodes: ReadonlyArray<{ nameWithOwner: string }>;
		};
	};
}

const PINNED_REPOS_QUERY = `
	query {
		viewer {
			pinnedItems(first: 6, types: [REPOSITORY]) {
				nodes { ... on Repository { nameWithOwner } }
			}
		}
	}
`;

// Best-effort name lookup: on any failure, warn with `label` and degrade to an empty Set
// rather than failing the caller — starred/pinned status is decorative, never load-bearing.
async function bestEffortNames(label: string, fetch: () => Promise<Set<string>>): Promise<Set<string>> {
	try {
		return await fetch();
	} catch (err) {
		console.warn(label, err);
		return new Set();
	}
}

function fetchStarredRepoNames(octokit: Octokit): Promise<Set<string>> {
	return bestEffortNames("Starred-repo lookup failed, defaulting to none:", async () => {
		const starred = await octokit.paginate(octokit.rest.activity.listReposStarredByAuthenticatedUser, {
			per_page: 100,
		});
		return new Set(starred.map((r) => r.full_name));
	});
}

function fetchPinnedRepoNames(octokit: Octokit): Promise<Set<string>> {
	return bestEffortNames("Pinned-repo lookup failed, defaulting to none:", async () => {
		const result = await octokit.graphql<PinnedItemsResponse>(PINNED_REPOS_QUERY);
		return new Set(result.viewer.pinnedItems.nodes.map((n) => n.nameWithOwner));
	});
}

const priority = (r: RepoSummary): number => (r.starred ? 0 : r.pinned ? 1 : 2);

// Enriches an already-fetched repo list with the signed-in user's starred/pinned status
// and sorts starred first, pinned next, preserving each tier's incoming order. Applied by
// the caller against a user-authenticated Octokit (never the installation client) — kept
// separate from listInstallationRepositories so this works unchanged whether the input
// list came from one installation or several merged ones.
export async function enrichWithStarredAndPinned(
	repos: ReadonlyArray<RepoSummary>,
	userOctokit: Octokit,
): Promise<ReadonlyArray<RepoSummary>> {
	const [starredNames, pinnedNames] = await Promise.all([
		fetchStarredRepoNames(userOctokit),
		fetchPinnedRepoNames(userOctokit),
	]);
	const enriched = repos.map((r) => ({
		...r,
		starred: starredNames.has(r.fullName),
		pinned: pinnedNames.has(r.fullName),
	}));
	return [...enriched].sort((a, b) => priority(a) - priority(b));
}

// The signed-in user's own full repo list (owner + collaborator + org-member affiliation,
// `listForAuthenticatedUser`'s default) — deliberately NOT best-effort like
// fetchStarredRepoNames/fetchPinnedRepoNames above: those degrade to "assume none" because
// starred/pinned is decorative, but here "assume none" would be indistinguishable from "GitHub
// confirmed no access," which the caller needs to tell apart from "we couldn't check" in order
// to fail closed instead of silently trusting an unfetched list. So this throws on failure and
// leaves the fallback decision to the caller.
export async function fetchUserAccessibleRepoNames(userOctokit: Octokit): Promise<Set<string>> {
	const repos = await userOctokit.paginate(userOctokit.rest.repos.listForAuthenticatedUser, { per_page: 100 });
	return new Set(repos.map((r) => r.full_name));
}

// Narrows a merged, installation-scoped repo list (which reflects what a team's GitHub App
// installation(s) were granted — nothing to do with any one team member's own GitHub access)
// down to what the requesting user could see themselves: public, or in their own
// owner/collaborator/org-member set. On a failed fetch of that set, fails closed to
// public-only rather than assuming the user has whatever private access the unfiltered list
// implied.
export async function filterReposAccessibleToUser(
	repos: ReadonlyArray<RepoSummary>,
	userOctokit: Octokit,
): Promise<ReadonlyArray<RepoSummary>> {
	let accessibleNames: Set<string>;
	try {
		accessibleNames = await fetchUserAccessibleRepoNames(userOctokit);
	} catch (err) {
		console.warn("User-accessible-repo lookup failed, filtering to public repos only:", err);
		return repos.filter((r) => !r.private);
	}
	return repos.filter((r) => !r.private || accessibleNames.has(r.fullName));
}

// Single-repo counterpart to filterReposAccessibleToUser, for call sites (like
// POST /repos/select) that only need to check one (owner, name) rather than filter a whole
// list — a targeted `GET /repos/{owner}/{repo}` as the user's own token is cheaper than
// paginating their entire repo list for a one-off check. GitHub answers this directly: 200
// means the token can see the repo (public, owned, or collaborator/org access); 403/404 means
// it can't. Any other failure (network blip, rate limit) is not treated as "no access" —
// it's rethrown so the caller doesn't silently deny a legitimate request on a transient error.
export async function isRepoAccessibleToUser(owner: string, name: string, userOctokit: Octokit): Promise<boolean> {
	try {
		await userOctokit.rest.repos.get({ owner, repo: name });
		return true;
	} catch (err) {
		if (isHttpError(err) && (err.status === 403 || err.status === 404)) return false;
		throw err;
	}
}
