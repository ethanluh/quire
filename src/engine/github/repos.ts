import type { Octokit } from "@octokit/rest";

export interface RepoSummary {
	owner: string;
	name: string;
	fullName: string;
	private: boolean;
	defaultBranch: string;
}

export async function listRepositories(octokit: Octokit): Promise<ReadonlyArray<RepoSummary>> {
	const repos = await octokit.paginate(octokit.rest.repos.listForAuthenticatedUser, {
		sort: "updated",
		per_page: 100,
	});
	return repos.map((r) => ({
		owner: r.owner.login,
		name: r.name,
		fullName: r.full_name,
		private: r.private,
		defaultBranch: r.default_branch,
	}));
}
