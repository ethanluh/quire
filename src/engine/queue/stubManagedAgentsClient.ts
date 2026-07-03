import type {
	AgentRef,
	CreateAgentParams,
	CreateSessionParams,
	EnvironmentRef,
	ManagedAgentsClient,
	ManagedAgentsEvent,
	ManagedAgentsSession,
	ManagedAgentsSessionStatus,
} from "./managedAgentsClient.js";

export class StubManagedAgentsClient implements ManagedAgentsClient {
	readonly createdAgents: CreateAgentParams[] = [];
	readonly createdEnvironments: Array<{ name: string }> = [];
	readonly createdSessions: CreateSessionParams[] = [];
	readonly sentMessages: Array<{ sessionId: string; text: string }> = [];
	private nextId = 1;
	private readonly sessionStatuses = new Map<string, ManagedAgentsSessionStatus>();
	private readonly sessionEvents = new Map<string, ManagedAgentsEvent[]>();

	async createAgent(params: CreateAgentParams): Promise<AgentRef> {
		this.createdAgents.push(params);
		return { id: `agent-${this.nextId++}`, version: 1 };
	}

	async createEnvironment(params: { name: string }): Promise<EnvironmentRef> {
		this.createdEnvironments.push(params);
		return { id: `env-${this.nextId++}` };
	}

	async createSession(params: CreateSessionParams): Promise<{ id: string }> {
		this.createdSessions.push(params);
		const id = `session-${this.nextId++}`;
		this.sessionStatuses.set(id, "running");
		return { id };
	}

	async sendUserMessage(sessionId: string, text: string): Promise<void> {
		this.sentMessages.push({ sessionId, text });
	}

	async getSession(sessionId: string): Promise<ManagedAgentsSession> {
		return { id: sessionId, status: this.sessionStatuses.get(sessionId) ?? "running" };
	}

	async listEvents(sessionId: string): Promise<ReadonlyArray<ManagedAgentsEvent>> {
		return this.sessionEvents.get(sessionId) ?? [];
	}

	// Test hooks — drive a session to a terminal state with a canned final message.
	setSessionStatus(sessionId: string, status: ManagedAgentsSessionStatus): void {
		this.sessionStatuses.set(sessionId, status);
	}

	setFinalAgentMessage(sessionId: string, text: string): void {
		const events = this.sessionEvents.get(sessionId) ?? [];
		events.push({ id: `evt-${this.nextId++}`, type: "agent.message", content: [{ type: "text", text }] });
		this.sessionEvents.set(sessionId, events);
	}
}
