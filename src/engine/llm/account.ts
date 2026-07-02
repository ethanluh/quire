import { rm } from "node:fs/promises";
import { readJsonFile, writeJsonFileAtomic } from "../jsonFile.js";

export interface ConnectedLlmAccount {
	provider: "anthropic" | "gemini";
	apiKey: string;
	connectedAt: string;
}

function isConnectedLlmAccount(value: unknown): value is ConnectedLlmAccount {
	return (
		typeof value === "object" &&
		value !== null &&
		((value as Record<string, unknown>)["provider"] === "anthropic" ||
			(value as Record<string, unknown>)["provider"] === "gemini") &&
		typeof (value as Record<string, unknown>)["apiKey"] === "string"
	);
}

export async function loadAccount(path: string): Promise<ConnectedLlmAccount | undefined> {
	return readJsonFile(path, isConnectedLlmAccount);
}

export async function saveAccount(path: string, account: ConnectedLlmAccount): Promise<void> {
	await writeJsonFileAtomic(path, account);
}

export async function clearAccount(path: string): Promise<void> {
	await rm(path, { force: true });
}
