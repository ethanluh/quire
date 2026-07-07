import { describe, it, expect, afterEach } from "@jest/globals";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildInvestigationTask,
	ensureDeepResolverAgent,
	pollInvestigationSession,
	startInvestigationSession,
} from "../../src/engine/queue/deepConflictInvestigation.js";
import { StubManagedAgentsClient } from "../../src/engine/queue/stubManagedAgentsClient.js";
import type { ConflictHunkEscalation } from "../../src/engine/queue/conflictResolution.js";
import type { PullRequest } from "../../src/engine/types/core.js";

function makePr(overrides: Partial<PullRequest> = {}): PullRequest {
	return {
		id: "pr-1",
		repoOwner: "org",
		repoName: "repo",
		number: 1,
		headSha: "head-sha",
		declaredDirection: "add passwordless auth",
		directionInferred: false,
		diff: { raw: "", hunks: [] },
		filesTouched: ["src/auth.ts"],
		symbolsTouched: [],
		testNamesChanged: [],
		ciStatus: "success",
		...overrides,
	};
}

function makeEscalation(overrides: Partial<ConflictHunkEscalation> = {}): ConflictHunkEscalation {
	return {
		path: "src/auth.ts",
		mode: "100644",
		oursSha: "ours-sha",
		theirsSha: "theirs-sha",
		mergeBaseSha: "base-sha",
		lowConfidenceHunks: [
			{
				hunk: { index: 0, baseLines: ["line2"], oursLines: ["line2-A"], theirsLines: ["line2-B"] },
				resolution: { resolution: "line2-merged", confidence: "low" },
			},
		],
		...overrides,
	};
}

describe("ensureDeepResolverAgent", () => {
	let dir: string;

	afterEach(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	it("creates the agent and environment once and persists the ref", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-deep-agent-"));
		const statePath = join(dir, "deep-resolver-agent.json");
		const client = new StubManagedAgentsClient();

		const ref = await ensureDeepResolverAgent(client, statePath);

		expect(client.createdAgents).toHaveLength(1);
		expect(client.createdEnvironments).toHaveLength(1);
		expect(ref).toEqual({ agentId: "agent-1", agentVersion: 1, environmentId: "env-2" });
	});

	it("reuses the persisted agent on a second call instead of creating another one", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-deep-agent-"));
		const statePath = join(dir, "deep-resolver-agent.json");
		const client = new StubManagedAgentsClient();

		const first = await ensureDeepResolverAgent(client, statePath);
		const second = await ensureDeepResolverAgent(client, statePath);

		expect(client.createdAgents).toHaveLength(1);
		expect(client.createdEnvironments).toHaveLength(1);
		expect(second).toEqual(first);
	});

	it("never grants the write or edit tools — defense in depth alongside the read-only repo token", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-deep-agent-"));
		const statePath = join(dir, "deep-resolver-agent.json");
		const client = new StubManagedAgentsClient();

		await ensureDeepResolverAgent(client, statePath);

		const toolset = client.createdAgents[0]?.tools?.[0] as { configs?: ReadonlyArray<{ name: string; enabled: boolean }> };
		const enabledToolNames = (toolset.configs ?? []).filter((c) => c.enabled).map((c) => c.name);
		expect(enabledToolNames).not.toContain("write");
		expect(enabledToolNames).not.toContain("edit");
	});
});

describe("buildInvestigationTask", () => {
	it("includes the declared direction, the conflicting hunk content, and the rejected attempt", () => {
		const task = buildInvestigationTask(makePr({ declaredDirection: "add passwordless auth" }), makeEscalation());

		expect(task).toContain("add passwordless auth");
		expect(task).toContain("line2-A");
		expect(task).toContain("line2-B");
		expect(task).toContain("line2-merged");
		expect(task).toContain("src/auth.ts");
	});
});

describe("startInvestigationSession", () => {
	it("mounts the repo read-only at the PR's head commit and sends the task as one message", async () => {
		const client = new StubManagedAgentsClient();
		const agentRef = { agentId: "agent-1", agentVersion: 1, environmentId: "env-1" };

		const { sessionId } = await startInvestigationSession(client, agentRef, makePr(), makeEscalation(), "repo-token");

		expect(client.createdSessions).toHaveLength(1);
		expect(client.createdSessions[0]).toMatchObject({
			agent: { type: "agent", id: "agent-1", version: 1 },
			environment_id: "env-1",
			resources: [
				{
					type: "github_repository",
					url: "https://github.com/org/repo",
					authorization_token: "repo-token",
					checkout: { type: "commit", sha: "head-sha" },
				},
			],
		});
		expect(client.sentMessages).toHaveLength(1);
		expect(client.sentMessages[0]?.sessionId).toBe(sessionId);
	});
});

describe("pollInvestigationSession", () => {
	it("reports not done while the session is still running", async () => {
		const client = new StubManagedAgentsClient();
		const { id: sessionId } = await client.createSession({
			agent: { type: "agent", id: "agent-1", version: 1 },
			environment_id: "env-1",
		});

		const result = await pollInvestigationSession(client, sessionId);

		expect(result).toEqual({ done: false });
	});

	it("parses a valid decision packet once the session goes idle", async () => {
		const client = new StubManagedAgentsClient();
		const { id: sessionId } = await client.createSession({
			agent: { type: "agent", id: "agent-1", version: 1 },
			environment_id: "env-1",
		});
		client.setSessionStatus(sessionId, "idle");
		const packet = {
			rationale: "merged both call sites",
			evidence: ["src/auth.ts:12 calls both"],
			testsRun: ["auth.test.ts"],
			testResult: "passed",
			confidence: "high",
			proposedResolution: "final file content",
		};
		client.setFinalAgentMessage(sessionId, JSON.stringify(packet));

		const result = await pollInvestigationSession(client, sessionId);

		expect(result).toEqual({ done: true, packet });
	});

	it("strips an accidental code fence around the decision packet", async () => {
		const client = new StubManagedAgentsClient();
		const { id: sessionId } = await client.createSession({
			agent: { type: "agent", id: "agent-1", version: 1 },
			environment_id: "env-1",
		});
		client.setSessionStatus(sessionId, "idle");
		const packet = {
			rationale: "r",
			evidence: [],
			testsRun: [],
			testResult: "unknown",
			confidence: "low",
			proposedResolution: "content",
		};
		client.setFinalAgentMessage(sessionId, "```json\n" + JSON.stringify(packet) + "\n```");

		const result = await pollInvestigationSession(client, sessionId);

		expect(result).toEqual({ done: true, packet });
	});

	it("fails closed when the session terminates with no final message", async () => {
		const client = new StubManagedAgentsClient();
		const { id: sessionId } = await client.createSession({
			agent: { type: "agent", id: "agent-1", version: 1 },
			environment_id: "env-1",
		});
		client.setSessionStatus(sessionId, "terminated");

		const result = await pollInvestigationSession(client, sessionId);

		if (!result.done) throw new Error("expected the poll to be done");
		expect(result.packet).toBeUndefined();
	});

	it("fails closed when the final message isn't valid JSON", async () => {
		const client = new StubManagedAgentsClient();
		const { id: sessionId } = await client.createSession({
			agent: { type: "agent", id: "agent-1", version: 1 },
			environment_id: "env-1",
		});
		client.setSessionStatus(sessionId, "idle");
		client.setFinalAgentMessage(sessionId, "I think the merge should keep ours.");

		const result = await pollInvestigationSession(client, sessionId);

		if (!result.done) throw new Error("expected the poll to be done");
		expect(result.packet).toBeUndefined();
	});
});
