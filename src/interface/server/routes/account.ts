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
import { rawPRPayloadToIncomingPR } from "../../../engine/github/toIncomingPR.js";
import { normalizePR } from "../../../engine/ingest/ingest.js";
import { orchestratePipeline } from "../../../engine/pipeline/pipeline.js";
import type { PipelineConfig } from "../../../engine/pipeline/pipeline.js";
import type { LlmProvider } from "../../../engine/drift/effectList/provider.js";
import type { StaticAnalyzer } from "../../../engine/drift/footprint/analyzer.js";
import type { AuditStore } from "../../../engine/gate/auditStore.js";
import type { InstrumentationSink } from "../../../engine/types/instrumentation.js";
import type { ServerState } from "../state.js";
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
	state: ServerState,
	pipelineConfig: PipelineConfig,
	provider: LlmProvider,
	analyzer: StaticAnalyzer,
	auditStore: AuditStore,
	instrumentationSink?: InstrumentationSink,
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

				// Selecting a repo re-populates the review queue from that repo's open PRs,
				// same pipeline /prs/ingest runs — the swarm's PRs land on the queue without
				// a separate manual ingest step.
				const rawPRs = await clientHolder.listOpenPullRequests(owner, name);
				const prs = rawPRs.map((raw) => normalizePR(rawPRPayloadToIncomingPR(raw)));
				const result = await orchestratePipeline(
					prs,
					pipelineConfig,
					provider,
					analyzer,
					auditStore,
					instrumentationSink,
				);
				for (const bundle of result.bundles) {
					state.bundles.set(bundle.id, bundle);
				}
				for (const card of result.cards) {
					state.cards.set(card.bundleId, card);
				}

				res.json({
					selected: account.selectedRepo,
					bundlesCreated: result.bundles.length,
					rejected: result.rejected.map((p) => p.id),
					shadowed: result.shadowed.map((p) => p.id),
					...(result.error !== undefined ? { error: result.error } : {}),
				});
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
