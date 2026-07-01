import { rm } from "node:fs/promises";
import { readJsonFile, writeJsonFileAtomic } from "../jsonFile.js";

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

function isConnectedAccount(value: unknown): value is ConnectedAccount {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as Record<string, unknown>)["login"] === "string" &&
		typeof (value as Record<string, unknown>)["token"] === "string"
	);
}

export async function loadAccount(path: string): Promise<ConnectedAccount | undefined> {
	return readJsonFile(path, isConnectedAccount);
}

export async function saveAccount(path: string, account: ConnectedAccount): Promise<void> {
	await writeJsonFileAtomic(path, account);
}

export async function clearAccount(path: string): Promise<void> {
	await rm(path, { force: true });
}
