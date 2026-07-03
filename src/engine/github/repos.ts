import type { Octokit } from "@octokit/rest";

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

async function fetchStarredRepoNames(octokit: Octokit): Promise<Set<string>> {
	try {
		const starred = await octokit.paginate(octokit.rest.activity.listReposStarredByAuthenticatedUser, {
			per_page: 100,
		});
		return new Set(starred.map((r) => r.full_name));
	} catch (err) {
		console.warn("Starred-repo lookup failed, defaulting to none:", err);
		return new Set();
	}
}

async function fetchPinnedRepoNames(octokit: Octokit): Promise<Set<string>> {
	try {
		const result = await octokit.graphql<PinnedItemsResponse>(PINNED_REPOS_QUERY);
		return new Set(result.viewer.pinnedItems.nodes.map((n) => n.nameWithOwner));
	} catch (err) {
		console.warn("Pinned-repo lookup failed, defaulting to none:", err);
		return new Set();
	}
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
