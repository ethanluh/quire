import { readFile, writeFile, rm, rename, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

export interface SelectedRepo {
	owner: string;
	name: string;
	// GitHub webhook id registered for this repo, if auto-registration succeeded — used to
	// remove it when switching to a different repo or disconnecting.
	webhookId?: number;
}

export interface ConnectedAccount {
	login: string;
	token: string;
	scopes: ReadonlyArray<string>;
	connectedAt: string;
	selectedRepo?: SelectedRepo;
	// Only set for an OAuth-connected account whose token expires (see oauth.ts) — a PAT,
	// or an OAuth App without token expiration enabled, leaves both undefined.
	refreshToken?: string;
	tokenExpiresAt?: string;
	// Set when a token refresh failed (or wasn't possible) and background ingestion has
	// stopped until the user reconnects — surfaced on GET /status for the UI to prompt.
	needsReconnect?: boolean;
}

export async function loadAccount(path: string): Promise<ConnectedAccount | undefined> {
	if (!existsSync(path)) return undefined;
	try {
		const raw = await readFile(path, "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			typeof (parsed as Record<string, unknown>)["login"] === "string" &&
			typeof (parsed as Record<string, unknown>)["token"] === "string"
		) {
			return parsed as ConnectedAccount;
		}
	} catch {
		// corrupted file — treat as not connected
	}
	return undefined;
}

export async function saveAccount(path: string, account: ConnectedAccount): Promise<void> {
	const dir = dirname(path);
	await mkdir(dir, { recursive: true });
	const tmp = `${path}.tmp`;
	await writeFile(tmp, JSON.stringify(account, null, 2), "utf8");
	await rename(tmp, path);
}

export async function clearAccount(path: string): Promise<void> {
	await rm(path, { force: true });
}
