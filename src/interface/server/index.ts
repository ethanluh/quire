import express from "express";
import { Octokit } from "@octokit/rest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAuditStore } from "../../engine/gate/auditStore.js";
import { MergeQueue } from "../../engine/queue/mergeQueue.js";
import type { GitHubClient } from "../../engine/github/client.js";
import { StubGitHubClient } from "../../engine/github/stubClient.js";
import { OctokitGitHubClient } from "../../engine/github/octokitClient.js";
import { GitHubClientHolder } from "../../engine/github/clientHolder.js";
import { loadAccount } from "../../engine/github/account.js";
import { fetchAuthenticatedUser } from "../../engine/github/verifyToken.js";
import { listRepositories } from "../../engine/github/repos.js";
import { resolveLlmProvider } from "./resolveLlmProvider.js";
import { TypeScriptAnalyzer } from "../../engine/drift/footprint/typescript.js";
import { createServerState } from "./state.js";
import { prsRouter } from "./routes/prs.js";
import { bundlesRouter } from "./routes/bundles.js";
import { gesturesRouter } from "./routes/gestures.js";
import { queueRouter } from "./routes/queue.js";
import { shelfRouter } from "./routes/shelf.js";
import { auditRouter } from "./routes/audit.js";
import { adminRouter } from "./routes/admin.js";
import { githubAccountRouter } from "./routes/account.js";
import { errorHandler } from "./middleware/errors.js";
import { createNdjsonInstrumentationSink } from "../../engine/instrumentation/logger.js";
import type { PipelineConfig } from "../../engine/pipeline/pipeline.js";
import type { PipelineDeps } from "./ingestIntoQueue.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "../../../data");
const QUEUE_PATH = join(DATA_DIR, "queue.json");
const DEFER_LOG_PATH = join(DATA_DIR, "instrumentation/defers.ndjson");
const GATE_LOG_PATH = join(DATA_DIR, "instrumentation/gate-decisions.ndjson");
const DRIFT_SCREEN_LOG_PATH = join(DATA_DIR, "instrumentation/drift-screen.ndjson");
const AUDIT_LOG_PATH = join(DATA_DIR, "instrumentation/audit.ndjson");
const ACCOUNT_PATH = join(DATA_DIR, "github-account.json");

const PORT = parseInt(process.env["PORT"] ?? "3000", 10);

const pipelineConfig: PipelineConfig = {
	gate: {
		criteria: [
			{ name: "buildFailure", mode: "enforce" },
			{ name: "outOfScope", mode: "off" },
			{ name: "duplicate", mode: "shadow" },
		],
	},
	bundle: { similarityThreshold: 0.75 },
};

async function main(): Promise<void> {
	const app = express();
	app.use(express.json());

	// Serve static UI
	app.use(express.static(join(__dirname, "../ui")));

	const auditStore = await loadAuditStore(AUDIT_LOG_PATH);
	const githubToken = process.env["GITHUB_TOKEN"];
	const connectedAccount = await loadAccount(ACCOUNT_PATH);

	// A connected account (set up through the UI) takes priority over GITHUB_TOKEN,
	// since it's the more recent, more deliberate choice of credential.
	let initialClient: GitHubClient;
	if (connectedAccount !== undefined) {
		initialClient = new OctokitGitHubClient(new Octokit({ auth: connectedAccount.token }));
		console.log(`GitHub client: octokit (connected as ${connectedAccount.login})`);
	} else if (githubToken !== undefined && githubToken !== "") {
		initialClient = new OctokitGitHubClient(new Octokit({ auth: githubToken }));
		console.log("GitHub client: octokit (GITHUB_TOKEN set)");
	} else {
		initialClient = new StubGitHubClient();
		console.log("GitHub client: stub (no connected account, GITHUB_TOKEN not set)");
	}
	const github = new GitHubClientHolder(initialClient);
	const queue = new MergeQueue(QUEUE_PATH, github);
	await queue.load();

	const { provider, description } = resolveLlmProvider(process.env);
	console.log(`LLM provider: ${description}`);
	const analyzer = new TypeScriptAnalyzer();
	const state = createServerState();
	const instrumentationSink = createNdjsonInstrumentationSink({
		gateLogPath: GATE_LOG_PATH,
		driftScreenLogPath: DRIFT_SCREEN_LOG_PATH,
	});
	const pipelineDeps: PipelineDeps = {
		config: pipelineConfig,
		provider,
		analyzer,
		auditStore,
		instrumentationSink,
	};

	app.use("/prs", prsRouter(state, pipelineDeps, queue));
	app.use("/bundles", bundlesRouter(state));
	app.use("/bundles", gesturesRouter(state, queue, DEFER_LOG_PATH, github));
	app.use("/queue", queueRouter(queue));
	app.use("/shelf", shelfRouter(state));
	app.use("/audit", auditRouter(auditStore));
	app.use(
		"/admin",
		adminRouter(state, auditStore, queue, [DEFER_LOG_PATH, GATE_LOG_PATH, DRIFT_SCREEN_LOG_PATH]),
	);
	app.use(
		"/account/github",
		githubAccountRouter(
			ACCOUNT_PATH,
			github,
			githubToken,
			fetchAuthenticatedUser,
			(token) => listRepositories(new Octokit({ auth: token })),
			connectedAccount,
			state,
			pipelineDeps,
		),
	);

	app.use(errorHandler);

	app.listen(PORT, () => {
		console.log(`Quire running on http://localhost:${PORT}`);
	});
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
