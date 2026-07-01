import { describe, it, expect } from "@jest/globals";
import { createHmac } from "node:crypto";
import express from "express";
import type { Server } from "node:http";
import { verifyGithubSignature } from "../../src/interface/server/middleware/webhookSignature.js";

const SECRET = "test-secret";

function sign(body: string, secret: string = SECRET): string {
	return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

async function startServer(): Promise<Server> {
	const app = express();
	app.use(express.raw({ type: "application/json" }));
	app.use(verifyGithubSignature(SECRET));
	app.post("/", (_req, res) => res.status(200).json({ ok: true }));
	const server = app.listen(0);
	await new Promise<void>((resolve) => server.once("listening", resolve));
	return server;
}

async function post(server: Server, body: string, signature?: string): Promise<number> {
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("no address");
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (signature !== undefined) headers["X-Hub-Signature-256"] = signature;
	const res = await fetch(`http://127.0.0.1:${address.port}/`, { method: "POST", headers, body });
	return res.status;
}

describe("verifyGithubSignature", () => {
	it("accepts a request with a valid signature", async () => {
		const server = await startServer();
		const body = JSON.stringify({ hello: "world" });

		const status = await post(server, body, sign(body));

		expect(status).toBe(200);
		await new Promise((resolve) => server.close(resolve));
	});

	it("rejects a request with a missing signature header", async () => {
		const server = await startServer();

		const status = await post(server, JSON.stringify({ hello: "world" }));

		expect(status).toBe(401);
		await new Promise((resolve) => server.close(resolve));
	});

	it("rejects a request with an incorrect signature", async () => {
		const server = await startServer();
		const body = JSON.stringify({ hello: "world" });

		const status = await post(server, body, sign(body, "wrong-secret"));

		expect(status).toBe(401);
		await new Promise((resolve) => server.close(resolve));
	});

	it("rejects a tampered body even if the signature was valid for the original body", async () => {
		const server = await startServer();
		const originalBody = JSON.stringify({ hello: "world" });
		const validSignature = sign(originalBody);

		const status = await post(server, JSON.stringify({ hello: "tampered" }), validSignature);

		expect(status).toBe(401);
		await new Promise((resolve) => server.close(resolve));
	});
});
