import { readFile, writeFile, rm, rename, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

export interface SelectedRepo {
	owner: string;
	name: string;
}

export interface ConnectedAccount {
	login: string;
	token: string;
	scopes: ReadonlyArray<string>;
	connectedAt: string;
	selectedRepo?: SelectedRepo;
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
