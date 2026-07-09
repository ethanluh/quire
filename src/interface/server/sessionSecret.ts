import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { readJsonFile, writeSecretFileAtomic } from "../../engine/jsonFile.js";

const SECRET_FILE_NAME = "session-secret.json";

interface PersistedSecret {
	secret: string;
}

function isPersistedSecret(value: unknown): value is PersistedSecret {
	return typeof value === "object" && value !== null && typeof (value as Record<string, unknown>)["secret"] === "string";
}

// QUIRE_SESSION_SECRET is the real answer for anything hosted — set once, it survives
// redeploys and restarts. When it's unset (local/dogfood use), a purely in-memory random
// secret used to be regenerated on every restart, which invalidated every session AND
// every outstanding invite link (invite.ts signs with this same secret) even though an
// invite's own TTL is 7 days, not "until the next restart." Persisting the generated
// secret to disk closes that gap without requiring the env var for local use.
export async function resolveSessionSecret(dataDir: string): Promise<string> {
	const envSecret = process.env["QUIRE_SESSION_SECRET"];
	if (envSecret !== undefined && envSecret !== "") return envSecret;

	const path = join(dataDir, SECRET_FILE_NAME);
	const persisted = await readJsonFile(path, isPersistedSecret);
	if (persisted !== undefined) return persisted.secret;

	const secret = randomBytes(32).toString("hex");
	// This key signs both session cookies and invite tokens — anyone who can read it can forge
	// a session for any login or an admin invite for any team, so write it 0600, not 0644.
	await writeSecretFileAtomic(path, { secret });
	console.warn(
		"QUIRE_SESSION_SECRET not set — generated one and saved it to " +
			`${path} so sessions and invite links survive a restart. Set the env var explicitly ` +
			"once hosted (e.g. `openssl rand -hex 32`) instead of relying on this file.",
	);
	return secret;
}
