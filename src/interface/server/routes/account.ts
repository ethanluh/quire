import { Router } from "express";
import { z } from "zod";
import { Octokit } from "@octokit/rest";
import type { ConnectedAccount } from "../../../engine/github/account.js";
import { saveAccount, clearAccount } from "../../../engine/github/account.js";
import type { GitHubClientHolder } from "../../../engine/github/clientHolder.js";
import { OctokitGitHubClient } from "../../../engine/github/octokitClient.js";
import { StubGitHubClient } from "../../../engine/github/stubClient.js";
import { InvalidTokenError } from "../../../engine/github/verifyToken.js";
import type { VerifiedTokenIdentity } from "../../../engine/github/verifyToken.js";
import type { RepoSummary } from "../../../engine/github/repos.js";
import { localOnly } from "../middleware/localOnly.js";
import { requireAdminHeader } from "../middleware/requireAdminHeader.js";
import { validateBody } from "../middleware/validation.js";

const ConnectSchema = z.object({
	token: z.string().min(1),
});

const SelectRepoSchema = z.object({
	owner: z.string().min(1),
	name: z.string().min(1),
});

function buildClientForFallback(fallbackToken: string | undefined): OctokitGitHubClient | StubGitHubClient {
	return fallbackToken !== undefined && fallbackToken !== ""
		? new OctokitGitHubClient(new Octokit({ auth: fallbackToken }))
		: new StubGitHubClient();
}

// `account` is in-memory, mirroring how ServerState holds bundles/cards/shelf in memory
// with the queue's on-disk state as the durable copy — `accountPath` is that copy.
export function githubAccountRouter(
	accountPath: string,
	clientHolder: GitHubClientHolder,
	fallbackToken: string | undefined,
	verifyToken: (token: string) => Promise<VerifiedTokenIdentity>,
	listRepos: (token: string) => Promise<ReadonlyArray<RepoSummary>>,
	initialAccount: ConnectedAccount | undefined,
): Router {
	const router = Router();
	let account = initialAccount;

	router.get("/status", (_req, res) => {
		if (account === undefined) {
			res.json({ connected: false });
			return;
		}
		res.json({
			connected: true,
			login: account.login,
			scopes: account.scopes,
			connectedAt: account.connectedAt,
			selectedRepo: account.selectedRepo,
		});
	});

	router.get("/repos", localOnly, requireAdminHeader, async (_req, res, next) => {
		try {
			if (account === undefined) {
				res.status(400).json({ error: "Connect a GitHub account first" });
				return;
			}
			const repos = await listRepos(account.token);
			res.json({ repos, selected: account.selectedRepo });
		} catch (err) {
			next(err);
		}
	});

	router.post(
		"/repos/select",
		localOnly,
		requireAdminHeader,
		validateBody(SelectRepoSchema),
		async (req, res, next) => {
			try {
				if (account === undefined) {
					res.status(400).json({ error: "Connect a GitHub account first" });
					return;
				}
				const { owner, name } = req.body as z.infer<typeof SelectRepoSchema>;
				account = { ...account, selectedRepo: { owner, name } };
				await saveAccount(accountPath, account);
				res.json({ selected: account.selectedRepo });
			} catch (err) {
				next(err);
			}
		},
	);

	router.post("/connect", localOnly, requireAdminHeader, validateBody(ConnectSchema), async (req, res, next) => {
		try {
			const { token } = req.body as z.infer<typeof ConnectSchema>;
			const identity = await verifyToken(token);

			account = {
				login: identity.login,
				token,
				scopes: identity.scopes,
				connectedAt: new Date().toISOString(),
			};
			await saveAccount(accountPath, account);
			clientHolder.setClient(new OctokitGitHubClient(new Octokit({ auth: token })));

			res.json({ connected: true, login: account.login, scopes: account.scopes, connectedAt: account.connectedAt });
		} catch (err) {
			if (err instanceof InvalidTokenError) {
				res.status(400).json({ error: err.message });
				return;
			}
			next(err);
		}
	});

	router.post("/disconnect", localOnly, requireAdminHeader, async (_req, res, next) => {
		try {
			account = undefined;
			await clearAccount(accountPath);
			clientHolder.setClient(buildClientForFallback(fallbackToken));
			res.json({ connected: false });
		} catch (err) {
			next(err);
		}
	});

	return router;
}
