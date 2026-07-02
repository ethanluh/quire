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
}

// GET /installation/repositories — the repos this specific installation was granted, not
// the connecting user's full repo list (which `listForAuthenticatedUser` returned under
// the old OAuth-token model, and which has no meaning for an installation-authenticated
// client — there is no "authenticated user" to list repos for).
export async function listInstallationRepositories(
	octokit: Octokit,
	installationId: number,
	accountLogin: string,
): Promise<ReadonlyArray<RepoSummary>> {
	const repos = await octokit.paginate(octokit.rest.apps.listReposAccessibleToInstallation, { per_page: 100 });
	return repos.map((r) => ({
		owner: r.owner.login,
		name: r.name,
		fullName: r.full_name,
		private: r.private,
		defaultBranch: r.default_branch,
		installationId,
		accountLogin,
	}));
}
