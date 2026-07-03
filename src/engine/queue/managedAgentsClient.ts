import { fetchWithRetry } from "../drift/effectList/httpRetry.js";

const ANTHROPIC_VERSION = "2023-06-01";
const MANAGED_AGENTS_BETA = "managed-agents-2026-04-01";

export interface AgentRef {
	id: string;
	version: number;
}

export interface EnvironmentRef {
	id: string;
}

export interface CreateAgentParams {
	name: string;
	model: string;
	system?: string;
	tools?: ReadonlyArray<Record<string, unknown>>;
}

export interface SessionResource {
	type: "github_repository";
	url: string;
	authorization_token: string;
	mount_path?: string;
	checkout?: { type: "branch"; name: string } | { type: "commit"; sha: string };
}

export interface CreateSessionParams {
	agent: { type: "agent"; id: string; version: number };
	environment_id: string;
	title?: string;
	resources?: ReadonlyArray<SessionResource>;
}

export type ManagedAgentsSessionStatus = "running" | "idle" | "rescheduling" | "terminated";

export interface ManagedAgentsSession {
	id: string;
	status: ManagedAgentsSessionStatus;
}

export interface ManagedAgentsEvent {
	id: string;
	type: string;
	content?: ReadonlyArray<{ type: string; text?: string }>;
}

// Thin wrapper around the Managed Agents REST surface — deliberately hand-rolled fetch
// rather than a new @anthropic-ai/sdk dependency, matching anthropicProvider.ts's existing
// style. Only the handful of calls deepConflictInvestigation.ts needs: create the resolver
// agent + environment once, start a session per escalated file, and poll it to completion.
export interface ManagedAgentsClient {
	createAgent(params: CreateAgentParams): Promise<AgentRef>;
	createEnvironment(params: { name: string }): Promise<EnvironmentRef>;
	createSession(params: CreateSessionParams): Promise<{ id: string }>;
	sendUserMessage(sessionId: string, text: string): Promise<void>;
	getSession(sessionId: string): Promise<ManagedAgentsSession>;
	listEvents(sessionId: string): Promise<ReadonlyArray<ManagedAgentsEvent>>;
}

interface CreateAgentResponse {
	id: string;
	version: number;
}

interface CreateEnvironmentResponse {
	id: string;
}

interface CreateSessionResponse {
	id: string;
}

interface GetSessionResponse {
	id: string;
	status: ManagedAgentsSessionStatus;
}

interface ListEventsResponse {
	data: ReadonlyArray<ManagedAgentsEvent>;
}

export class AnthropicManagedAgentsClient implements ManagedAgentsClient {
	private readonly baseUrl: string;

	constructor(
		private readonly apiKey: string,
		baseUrl = "https://api.anthropic.com",
	) {
		this.baseUrl = baseUrl;
	}

	private headers(): Record<string, string> {
		return {
			"content-type": "application/json",
			"x-api-key": this.apiKey,
			"anthropic-version": ANTHROPIC_VERSION,
			"anthropic-beta": MANAGED_AGENTS_BETA,
		};
	}

	async createAgent(params: CreateAgentParams): Promise<AgentRef> {
		const res = await fetchWithRetry("Anthropic", `${this.baseUrl}/v1/agents`, {
			method: "POST",
			headers: this.headers(),
			body: JSON.stringify(params),
		});
		const data = (await res.json()) as CreateAgentResponse;
		return { id: data.id, version: data.version };
	}

	async createEnvironment(params: { name: string }): Promise<EnvironmentRef> {
		const res = await fetchWithRetry("Anthropic", `${this.baseUrl}/v1/environments`, {
			method: "POST",
			headers: this.headers(),
			body: JSON.stringify({ name: params.name, config: { type: "cloud", networking: { type: "unrestricted" } } }),
		});
		const data = (await res.json()) as CreateEnvironmentResponse;
		return { id: data.id };
	}

	async createSession(params: CreateSessionParams): Promise<{ id: string }> {
		const res = await fetchWithRetry("Anthropic", `${this.baseUrl}/v1/sessions`, {
			method: "POST",
			headers: this.headers(),
			body: JSON.stringify(params),
		});
		const data = (await res.json()) as CreateSessionResponse;
		return { id: data.id };
	}

	async sendUserMessage(sessionId: string, text: string): Promise<void> {
		await fetchWithRetry("Anthropic", `${this.baseUrl}/v1/sessions/${sessionId}/events`, {
			method: "POST",
			headers: this.headers(),
			body: JSON.stringify({ events: [{ type: "user.message", content: [{ type: "text", text }] }] }),
		});
	}

	async getSession(sessionId: string): Promise<ManagedAgentsSession> {
		const res = await fetchWithRetry("Anthropic", `${this.baseUrl}/v1/sessions/${sessionId}`, {
			method: "GET",
			headers: this.headers(),
		});
		const data = (await res.json()) as GetSessionResponse;
		return { id: data.id, status: data.status };
	}

	async listEvents(sessionId: string): Promise<ReadonlyArray<ManagedAgentsEvent>> {
		const res = await fetchWithRetry("Anthropic", `${this.baseUrl}/v1/sessions/${sessionId}/events`, {
			method: "GET",
			headers: this.headers(),
		});
		const data = (await res.json()) as ListEventsResponse;
		return data.data;
	}
}
