import type { Octokit } from "@octokit/rest";

export interface RepoSummary {
	owner: string;
	name: string;
	fullName: string;
	private: boolean;
	defaultBranch: string;
}

// GET /installation/repositories — the repos this specific installation was granted,
// not the connecting user's full repo list (which `listForAuthenticatedUser` returned
// under the old OAuth-token model, and which has no meaning for an installation-
// authenticated client — there is no "authenticated user" to list repos for). Drops the
// old starred/pinned prioritization: those were user-scoped GraphQL/REST calls with no
// installation equivalent, and an installation's repo list is already small (exactly
// what an org admin explicitly granted), so sort order matters less.
export async function listInstallationRepositories(octokit: Octokit): Promise<ReadonlyArray<RepoSummary>> {
	const repos = await octokit.paginate(octokit.rest.apps.listReposAccessibleToInstallation, { per_page: 100 });
	return repos
		.filter((r) => !r.archived)
		.map((r) => ({
			owner: r.owner.login,
			name: r.name,
			fullName: r.full_name,
			private: r.private,
			defaultBranch: r.default_branch,
		}));
}
