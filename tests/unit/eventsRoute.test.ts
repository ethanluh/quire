import { describe, it, expect, afterEach } from "@jest/globals";
import express from "express";
import type { Server } from "node:http";
import { eventsRouter } from "../../src/interface/server/routes/events.js";
import { notifyStateChanged } from "../../src/interface/server/changeEvents.js";

describe("eventsRouter", () => {
	let server: Server;

	afterEach(async () => {
		if (server) {
			// SSE connections are long-lived keep-alive sockets — close() alone waits for them
			// to end on their own, which can outlast a test that only aborted the client side.
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
		}
	});

	async function connect(teamId = "team-a"): Promise<{ port: number; reader: ReadableStreamDefaultReader<Uint8Array>; controller: AbortController }> {
		const app = express();
		app.use("/events", eventsRouter(teamId));
		server = app.listen(0);
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("no address");

		const controller = new AbortController();
		const res = await fetch(`http://127.0.0.1:${address.port}/events`, { signal: controller.signal });
		expect(res.headers.get("content-type")).toContain("text/event-stream");
		if (res.body === null) throw new Error("expected a streamed body");
		return { port: address.port, reader: res.body.getReader(), controller };
	}

	async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
		const { value, done } = await reader.read();
		if (done || value === undefined) throw new Error("stream ended before a chunk arrived");
		return Buffer.from(value).toString("utf8");
	}

	it("pushes a refresh event to a connected client on notifyStateChanged()", async () => {
		const { reader, controller } = await connect("team-a");

		notifyStateChanged("team-a");

		expect(await readChunk(reader)).toBe("data: refresh\n\n");
		controller.abort();
	});

	it("delivers a single notifyStateChanged() to every connected client of that team", async () => {
		const first = await connect("team-a");
		const secondController = new AbortController();
		const secondRes = await fetch(`http://127.0.0.1:${first.port}/events`, { signal: secondController.signal });
		if (secondRes.body === null) throw new Error("expected a streamed body");
		const secondReader = secondRes.body.getReader();

		notifyStateChanged("team-a");

		expect(await readChunk(first.reader)).toBe("data: refresh\n\n");
		expect(await readChunk(secondReader)).toBe("data: refresh\n\n");
		first.controller.abort();
		secondController.abort();
	});

	it("stops writing to a disconnected client without throwing", async () => {
		const { reader, controller } = await connect("team-a");
		controller.abort();
		await reader.cancel().catch(() => undefined);

		// Give the server a tick to observe the close event and unsubscribe.
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(() => notifyStateChanged("team-a")).not.toThrow();
	});

	it("never wakes a connection belonging to a different team", async () => {
		const { reader, controller } = await connect("team-a");

		notifyStateChanged("team-b");

		// Nothing should arrive for team-a; race a short timeout against the read.
		const result = await Promise.race([
			readChunk(reader).then(() => "delivered"),
			new Promise((resolve) => setTimeout(() => resolve("timed-out"), 50)),
		]);

		expect(result).toBe("timed-out");
		controller.abort();
	});
});
