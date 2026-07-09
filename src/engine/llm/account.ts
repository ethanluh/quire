import { rm } from "node:fs/promises";
import { readJsonFile, writeSecretFileAtomic } from "../jsonFile.js";

export interface ConnectedLlmAccount {
	provider: "anthropic" | "gemini";
	apiKey: string;
	connectedAt: string;
}

function isConnectedLlmAccount(value: unknown): value is ConnectedLlmAccount {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	return (
		(v["provider"] === "anthropic" || v["provider"] === "gemini") &&
		typeof v["apiKey"] === "string" &&
		v["apiKey"].length > 0 &&
		typeof v["connectedAt"] === "string" &&
		v["connectedAt"].length > 0
	);
}

export async function loadAccount(path: string): Promise<ConnectedLlmAccount | undefined> {
	return readJsonFile(path, isConnectedLlmAccount);
}

export async function saveAccount(path: string, account: ConnectedLlmAccount): Promise<void> {
	// account.apiKey is a live provider credential — write it 0600, not the default 0644.
	await writeSecretFileAtomic(path, account);
}

export async function clearAccount(path: string): Promise<void> {
	await rm(path, { force: true });
}
