import { appendNdjson } from "../instrumentation/store.js";

export interface PlatformAdminAction {
	actor: string;
	action: string;
	detail: unknown;
	recordedAt: string;
}

// The highest-privilege surface in the app (cross-tenant, affects every team's gate
// behavior or who else can reach this console) gets its own append-only trail, independent
// of any team's own per-tenant audit log — so "who changed the platform-wide policy, and
// when" is answerable without correlating across every team's instrumentation files.
export async function logPlatformAdminAction(path: string, actor: string, action: string, detail: unknown): Promise<void> {
	await appendNdjson(path, { actor, action, detail, recordedAt: new Date().toISOString() } satisfies PlatformAdminAction);
}
