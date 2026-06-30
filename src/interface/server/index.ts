import express from "express";
import { Octokit } from "@octokit/rest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AuditStore } from "../../engine/gate/auditStore.js";
import { MergeQueue } from "../../engine/queue/mergeQueue.js";
import type { GitHubClient } from "../../engine/github/client.js";
import { StubGitHubClient } from "../../engine/github/stubClient.js";
import { OctokitGitHubClient } from "../../engine/github/octokitClient.js";
import { StubLlmProvider } from "../../engine/drift/effectList/stubProvider.js";
import { TypeScriptAnalyzer } from "../../engine/drift/footprint/typescript.js";
import { createServerState } from "./state.js";
import { prsRouter } from "./routes/prs.js";
import { bundlesRouter } from "./routes/bundles.js";
import { gesturesRouter } from "./routes/gestures.js";
import { queueRouter } from "./routes/queue.js";
import { shelfRouter } from "./routes/shelf.js";
import { auditRouter } from "./routes/audit.js";
import { adminRouter } from "./routes/admin.js";
import { errorHandler } from "./middleware/errors.js";
import type { PipelineConfig } from "../../engine/pipeline/pipeline.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "../../../data");
const QUEUE_PATH = join(DATA_DIR, "queue.json");
const DEFER_LOG_PATH = join(DATA_DIR, "instrumentation/defers.ndjson");

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

	const auditStore = new AuditStore();
	const githubToken = process.env["GITHUB_TOKEN"];
	const useRealGithub = githubToken !== undefined && githubToken !== "";
	const github: GitHubClient = useRealGithub
		? new OctokitGitHubClient(new Octokit({ auth: githubToken }))
		: new StubGitHubClient();
	console.log(useRealGithub ? "GitHub client: octokit (GITHUB_TOKEN set)" : "GitHub client: stub (GITHUB_TOKEN not set)");
	const queue = new MergeQueue(QUEUE_PATH, github);
	await queue.load();

	const provider = new StubLlmProvider();
	const analyzer = new TypeScriptAnalyzer();
	const state = createServerState();

	app.use("/prs", prsRouter(state, pipelineConfig, provider, analyzer, auditStore, queue));
	app.use("/bundles", bundlesRouter(state));
	app.use("/bundles", gesturesRouter(state, queue, DEFER_LOG_PATH));
	app.use("/queue", queueRouter(queue));
	app.use("/shelf", shelfRouter(state));
	app.use("/audit", auditRouter(auditStore));
	app.use("/admin", adminRouter(state, auditStore, queue, DEFER_LOG_PATH));

	app.use(errorHandler);

	app.listen(PORT, () => {
		console.log(`Quire running on http://localhost:${PORT}`);
	});
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
