import { readJsonFile, writeJsonFileAtomic } from "../jsonFile.js";
import { stripCodeFence } from "../drift/effectList/stripCodeFence.js";
import type { PullRequest } from "../types/core.js";
import type { DecisionPacket } from "../types/queue.js";
import type { ConflictHunk } from "./conflictHunks.js";
import type { ConflictHunkEscalation } from "./conflictResolution.js";
import type { ManagedAgentsClient } from "./managedAgentsClient.js";
import type { SemanticHunkResolution } from "./semanticHunkResolver.js";

// Opus-tier on purpose: this only ever runs on the tail the fast (cheaper) resolver already
// couldn't clear with confidence, so the cost of a stronger model is warranted here in a way
// it wouldn't be for the batched hunk-resolution call in semanticHunkResolver.ts.
const AGENT_MODEL = "claude-opus-4-8";

export interface DeepResolverAgentRef {
	agentId: string;
	agentVersion: number;
	environmentId: string;
}

function isDeepResolverAgentRef(value: unknown): value is DeepResolverAgentRef {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	return typeof v["agentId"] === "string" && typeof v["agentVersion"] === "number" && typeof v["environmentId"] === "string";
}

const AGENT_SYSTEM_PROMPT = [
	"You investigate a single merge conflict Quire's fast, cheap resolver could not confidently",
	"resolve on its own. You are read-only: the repository is mounted with a GitHub token",
	"scoped to Contents:Read only, so even a `git push` or `git commit` you attempt will be",
	"rejected by GitHub — Quire applies your proposed resolution itself, through its own",
	"commit pipeline, only if a human reviewer accepts it. Never claim you committed or pushed",
	"anything.",
	"",
	"Investigate, then stop — do not keep iterating once you've formed a view. Your final",
	"message must be a single JSON object and nothing else (no markdown fence, no prose",
	"before or after) with this exact shape:",
	'{"rationale": string, "evidence": string[], "testsRun": string[], "testResult": "passed" | "failed" | "unknown", "confidence": "high" | "medium" | "low", "openQuestion"?: string, "proposedResolution": string}',
	"`proposedResolution` must be the full content of the entire file after your merge — not a",
	"diff and not just the conflicting hunk.",
].join("\n");

// Created once, ever, and reused — Managed Agents' own guidance warns against calling
// agents.create()/environments.create() per session, which would accumulate orphaned agent
// objects and pay create latency on every conflict. Persisted so a server restart reuses the
// same agent+environment rather than minting a new pair.
export async function ensureDeepResolverAgent(client: ManagedAgentsClient, statePath: string): Promise<DeepResolverAgentRef> {
	const existing = await readJsonFile(statePath, isDeepResolverAgentRef);
	if (existing !== undefined) return existing;

	const agent = await client.createAgent({
		name: "Quire deep conflict resolver",
		model: AGENT_MODEL,
		system: AGENT_SYSTEM_PROMPT,
		// write/edit deliberately left disabled — defense in depth alongside the read-only
		// repo token, per the read-only-agent/Quire-applies-the-write design decision.
		tools: [
			{
				type: "agent_toolset_20260401",
				default_config: { enabled: false },
				configs: [
					{ name: "bash", enabled: true },
					{ name: "read", enabled: true },
					{ name: "grep", enabled: true },
					{ name: "glob", enabled: true },
				],
			},
		],
	});
	const environment = await client.createEnvironment({ name: "Quire deep conflict resolver" });
	const ref: DeepResolverAgentRef = { agentId: agent.id, agentVersion: agent.version, environmentId: environment.id };
	await writeJsonFileAtomic(statePath, ref);
	return ref;
}

function renderHunkForInvestigation(hunk: ConflictHunk, resolution: SemanticHunkResolution): string {
	const side = (label: string, lines: ReadonlyArray<string>): string => `  ${label}:\n${lines.map((l) => `    ${l}`).join("\n")}`;
	return [
		`Conflicting hunk (index ${hunk.index}):`,
		side("base (common ancestor)", hunk.baseLines),
		side("ours (this PR's branch)", hunk.oursLines),
		side("theirs (the branch it's merging into)", hunk.theirsLines),
		`  fast resolver's rejected attempt (confidence: ${resolution.confidence}):\n${resolution.resolution
			.split("\n")
			.map((l) => `    ${l}`)
			.join("\n")}`,
	].join("\n");
}

export function buildInvestigationTask(pr: PullRequest, escalation: ConflictHunkEscalation): string {
	const plural = escalation.lowConfidenceHunks.length > 1;
	return [
		`A merge conflict in \`${escalation.path}\` could not be confidently auto-resolved.`,
		// declaredDirection is the PR author's own label, not a verified fact (INV-1) — worth
		// flagging explicitly so the agent treats it as a lead to check, not ground truth.
		`This PR's declared direction (author-supplied, unverified): "${pr.declaredDirection}"`,
		"",
		`${escalation.lowConfidenceHunks.length} conflicting hunk${plural ? "s" : ""} need review:`,
		"",
		escalation.lowConfidenceHunks.map(({ hunk, resolution }) => renderHunkForInvestigation(hunk, resolution)).join("\n\n"),
		"",
		"Your task, bounded:",
		"1. Use `git log` and `git blame` on the repository already checked out in your working directory to understand why each side changed this code.",
		"2. Use `grep`/`glob` to find other call sites a wrong merge would break.",
		"3. If a test suite scoped to this file exists, run only that scoped suite — not the full suite.",
		"4. Propose one merged resolution for the whole file, verify it against what you found, then stop — one propose-then-verify pass, not an open-ended loop.",
	].join("\n");
}

export interface StartedInvestigation {
	sessionId: string;
}

// Mounts the PR's head commit read-only (see AGENT_SYSTEM_PROMPT — the token itself is
// Contents:Read-scoped) and sends the task as a single message. Returns as soon as the
// session is created and the message is queued — the caller polls separately via
// pollInvestigationSession rather than blocking here.
export async function startInvestigationSession(
	client: ManagedAgentsClient,
	agentRef: DeepResolverAgentRef,
	pr: PullRequest,
	escalation: ConflictHunkEscalation,
	repoToken: string,
): Promise<StartedInvestigation> {
	const session = await client.createSession({
		agent: { type: "agent", id: agentRef.agentId, version: agentRef.agentVersion },
		environment_id: agentRef.environmentId,
		title: `Conflict investigation: ${pr.repoOwner}/${pr.repoName}#${pr.number} — ${escalation.path}`,
		resources: [
			{
				type: "github_repository",
				url: `https://github.com/${pr.repoOwner}/${pr.repoName}`,
				authorization_token: repoToken,
				checkout: { type: "commit", sha: pr.headSha },
			},
		],
	});
	await client.sendUserMessage(session.id, buildInvestigationTask(pr, escalation));
	return { sessionId: session.id };
}

export type InvestigationPollResult =
	| { done: false }
	| { done: true; packet: DecisionPacket }
	| { done: true; packet?: undefined; reason: string };

function isDecisionPacket(value: unknown): value is DecisionPacket {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	return (
		typeof v["rationale"] === "string" &&
		Array.isArray(v["evidence"]) &&
		Array.isArray(v["testsRun"]) &&
		(v["testResult"] === "passed" || v["testResult"] === "failed" || v["testResult"] === "unknown") &&
		(v["confidence"] === "high" || v["confidence"] === "medium" || v["confidence"] === "low") &&
		typeof v["proposedResolution"] === "string"
	);
}

// Never blocks — a single non-blocking status check + (if terminal) one events fetch, meant
// to be called from a periodic poll (see MergeQueue.pollInvestigations), not awaited inline
// on the merge-queue lock.
export async function pollInvestigationSession(client: ManagedAgentsClient, sessionId: string): Promise<InvestigationPollResult> {
	const session = await client.getSession(sessionId);
	if (session.status === "running" || session.status === "rescheduling") return { done: false };

	const events = await client.listEvents(sessionId);
	const lastMessage = [...events].reverse().find((e) => e.type === "agent.message");
	const text = lastMessage?.content?.find((b) => b.type === "text")?.text;
	if (text === undefined) {
		return { done: true, reason: "session ended without a final message from the agent" };
	}
	try {
		const parsed: unknown = JSON.parse(stripCodeFence(text));
		if (!isDecisionPacket(parsed)) {
			return { done: true, reason: "agent's final message was not a valid decision packet" };
		}
		return { done: true, packet: parsed };
	} catch {
		return { done: true, reason: "agent's final message was not valid JSON" };
	}
}
