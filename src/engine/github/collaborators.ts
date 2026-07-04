import type { Octokit } from "@octokit/rest";
import { loadInstallation } from "./installation.js";
import { isHttpError } from "./octokitClient.js";
import type { TeamRole } from "../types/team.js";

// A per-installation Octokit factory, not a raw GitHubAppConfig — same shape tenant.ts
// already hands githubAppRouter (e.g. `(installationId) => buildInstallationClient(...)`),
// so tests can inject a fake Octokit directly instead of mocking installationClient.js.
export type BuildOctokit = (installationId: number) => Octokit;

export interface RepoCollaboratorSynced {
	owner: string;
	name: string;
	outcome: "added" | "removed";
}

export interface RepoCollaboratorFailed {
	owner: string;
	name: string;
	outcome: "failed";
	reason: "insufficient-permission" | "github-error";
	error: unknown;
}

export type CollaboratorSyncResult = RepoCollaboratorSynced | RepoCollaboratorFailed;

function roleToPermission(role: TeamRole): "push" | "pull" {
	return role === "owner" || role === "admin" ? "push" : "pull";
}

function classifyFailure(owner: string, name: string, err: unknown): RepoCollaboratorFailed {
	// Same duck-typed 403 detection octokitClient.ts's withPermissionHint uses — only the
	// detection is reused here, not the throw-a-friendlier-error behavior, since these calls
	// have no HTTP response of their own to attach one to.
	if (isHttpError(err) && err.status === 403 && /Resource not accessible by integration/i.test(err.message)) {
		return { owner, name, outcome: "failed", reason: "insufficient-permission", error: err };
	}
	return { owner, name, outcome: "failed", reason: "github-error", error: err };
}

// Adds `login` as a collaborator on every repo the team currently has bound (a team can
// watch several concurrently — see installation.ts's RepoBinding). Best-effort per repo:
// never throws, so one repo's failure (revoked installation, missing permission) never
// stops the sync from reaching the team's other repos, and never blocks the caller's own
// Quire-side team mutation. An empty result means the team has no repos bound yet.
export async function addTeamMemberAsCollaborator(
	buildOctokit: BuildOctokit,
	installationPath: string,
	login: string,
	role: TeamRole,
): Promise<ReadonlyArray<CollaboratorSyncResult>> {
	const state = await loadInstallation(installationPath);
	const repos = state?.repos ?? [];
	return Promise.all(
		repos.map(async (repo): Promise<CollaboratorSyncResult> => {
			try {
				const octokit = buildOctokit(repo.installationId);
				await octokit.rest.repos.addCollaborator({
					owner: repo.owner,
					repo: repo.name,
					username: login,
					permission: roleToPermission(role),
				});
				return { owner: repo.owner, name: repo.name, outcome: "added" };
			} catch (err) {
				return classifyFailure(repo.owner, repo.name, err);
			}
		}),
	);
}

interface BoundRepo {
	owner: string;
	name: string;
	installationId: number;
}

// Shared by removeTeamMemberAsCollaborator (one login, every bound repo) and
// removeCollaboratorsFromRepo (one repo, several logins) below. A 404 (login was never
// actually added — e.g. the original add failed on insufficient permission) is treated as
// success, not failure, so a leave/remove/unbind never logs a spurious error for a
// collaborator relationship that never existed.
async function removeOneCollaborator(buildOctokit: BuildOctokit, repo: BoundRepo, login: string): Promise<CollaboratorSyncResult> {
	try {
		const octokit = buildOctokit(repo.installationId);
		await octokit.rest.repos.removeCollaborator({ owner: repo.owner, repo: repo.name, username: login });
		return { owner: repo.owner, name: repo.name, outcome: "removed" };
	} catch (err) {
		if (isHttpError(err) && err.status === 404) {
			return { owner: repo.owner, name: repo.name, outcome: "removed" };
		}
		return classifyFailure(repo.owner, repo.name, err);
	}
}

// Removes `login` as a collaborator from every repo the team currently has bound.
export async function removeTeamMemberAsCollaborator(
	buildOctokit: BuildOctokit,
	installationPath: string,
	login: string,
): Promise<ReadonlyArray<CollaboratorSyncResult>> {
	const state = await loadInstallation(installationPath);
	const repos = state?.repos ?? [];
	return Promise.all(repos.map((repo) => removeOneCollaborator(buildOctokit, repo, login)));
}

// Removes every one of `logins` as a collaborator from one specific repo — the counterpart
// to removeTeamMemberAsCollaborator's "one login, every bound repo" shape, used when a repo
// itself is unbound from a team (rather than a login leaving it) so every current member's
// GitHub access on that now-unwatched repo is revoked too, not just left to expire on a
// later leave (which by then would no longer see the repo in `installation.json` to loop
// over — see the callers in githubApp.ts).
export async function removeCollaboratorsFromRepo(
	buildOctokit: BuildOctokit,
	repo: BoundRepo,
	logins: ReadonlyArray<string>,
): Promise<ReadonlyArray<CollaboratorSyncResult>> {
	return Promise.all(logins.map((login) => removeOneCollaborator(buildOctokit, repo, login)));
}
