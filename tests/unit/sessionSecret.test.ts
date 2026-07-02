import { describe, it, expect, afterEach, beforeEach } from "@jest/globals";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSessionSecret } from "../../src/interface/server/sessionSecret.js";

describe("resolveSessionSecret", () => {
	let dir: string;
	const originalEnv = process.env["QUIRE_SESSION_SECRET"];

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-sessionsecret-"));
		delete process.env["QUIRE_SESSION_SECRET"];
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
		if (originalEnv !== undefined) process.env["QUIRE_SESSION_SECRET"] = originalEnv;
	});

	it("uses QUIRE_SESSION_SECRET when set, without touching disk", async () => {
		process.env["QUIRE_SESSION_SECRET"] = "explicit-secret";

		const secret = await resolveSessionSecret(dir);

		expect(secret).toBe("explicit-secret");
	});

	it("persists a generated secret to disk when the env var is unset", async () => {
		const secret = await resolveSessionSecret(dir);

		expect(secret).toHaveLength(64);
	});

	it("reuses the persisted secret across calls instead of regenerating it (survives a restart)", async () => {
		const first = await resolveSessionSecret(dir);
		const second = await resolveSessionSecret(dir);

		expect(second).toBe(first);
	});
});
