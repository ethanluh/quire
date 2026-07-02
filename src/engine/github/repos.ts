import type { Octokit } from "@octokit/rest";

export interface RepoSummary {
	owner: string;
	name: string;
	fullName: string;
	private: boolean;
	defaultBranch: string;
	starred: boolean;
	pinned: boolean;
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

export async function listRepositories(octokit: Octokit): Promise<ReadonlyArray<RepoSummary>> {
	const [repos, starredNames, pinnedNames] = await Promise.all([
		octokit.paginate(octokit.rest.repos.listForAuthenticatedUser, {
			sort: "updated",
			per_page: 100,
		}),
		fetchStarredRepoNames(octokit),
		fetchPinnedRepoNames(octokit),
	]);

	const summaries = repos
		.filter((r) => !r.archived)
		.map((r) => ({
			owner: r.owner.login,
			name: r.name,
			fullName: r.full_name,
			private: r.private,
			defaultBranch: r.default_branch,
			starred: starredNames.has(r.full_name),
			pinned: pinnedNames.has(r.full_name),
		}));

	const priority = (r: RepoSummary): number => (r.starred ? 0 : r.pinned ? 1 : 2);
	return summaries.sort((a, b) => priority(a) - priority(b));
}
