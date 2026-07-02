import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";
import { RequestError } from "@octokit/request-error";
import { OctokitGitHubClient } from "./octokitClient.js";

export interface GitHubAppConfig {
	appId: string;
	privateKey: string;
}

// Thrown when a token-mint or API call fails because the installation was removed,
// suspended, or lost access to the repo in question (401/404 from GitHub's side) —
// replaces the old ensureValidAccessToken/NeedsReconnectError flow. There's no proactive
// pre-check the way an expiring OAuth token had one: an installation grant doesn't decay
// on a schedule, it just works or it doesn't, discovered by the call itself.
export class InstallationRevokedError extends Error {}

export function isInstallationRevoked(err: unknown): boolean {
	return err instanceof RequestError && (err.status === 401 || err.status === 404);
}

export function buildInstallationOctokit(config: GitHubAppConfig, installationId: number): Octokit {
	return new Octokit({
		authStrategy: createAppAuth,
		auth: { appId: config.appId, privateKey: config.privateKey, installationId },
	});
}

// OctokitGitHubClient itself needs no changes to support this — it only ever calls
// this.octokit.rest.*/graphql/paginate, agnostic to how the instance authenticates.
export function buildInstallationClient(config: GitHubAppConfig, installationId: number): OctokitGitHubClient {
	return new OctokitGitHubClient(buildInstallationOctokit(config, installationId));
}

export interface InstallationAccount {
	accountLogin: string;
	accountType: "User" | "Organization";
}

// No installationId here — GET /app/installations/{id} is an app-level endpoint,
// authenticated as the app itself (a JWT), not as any one installation.
function buildAppOctokit(config: GitHubAppConfig): Octokit {
	return new Octokit({
		authStrategy: createAppAuth,
		auth: { appId: config.appId, privateKey: config.privateKey },
	});
}

// Looked up directly rather than guessed from the installation's repo list (which is
// empty for a repo-less org install, and says nothing about account type anyway).
export async function getInstallationAccount(
	config: GitHubAppConfig,
	installationId: number,
): Promise<InstallationAccount> {
	const { data } = await buildAppOctokit(config).rest.apps.getInstallation({ installation_id: installationId });
	// `account` is a simple-user for a User/Organization install, or an `enterprise` (no
	// `login` field, only `slug`) for the rare enterprise-owned case — fall back the same
	// way the old repo-derived logic did when there's nothing else to go on.
	const account = data.account;
	const accountLogin = account !== null && account !== undefined && "login" in account ? account.login : undefined;
	return {
		accountLogin: accountLogin ?? `installation-${installationId}`,
		accountType: data.target_type === "User" ? "User" : "Organization",
	};
}
