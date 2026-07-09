import { Router } from "express";
import { onStateChanged } from "../changeEvents.js";

// Mounted at /events, behind the same session gate as /prs, /bundles, /queue, /shelf (see
// index.ts). Push-side companion to those polling endpoints: emits a no-payload "refresh"
// event whenever server state changes so the browser doesn't have to wait for its next poll
// tick. The client still polls independently (see index.html/mobile.html) as a fallback for
// a dropped/unsupported connection — this is the fast path, not the only path.
// Ceiling on concurrent SSE connections across the whole process. Each open connection pins a
// socket/FD and an EventEmitter listener, so without a cap a single authenticated (or
// compromised) account could open thousands and exhaust file descriptors/memory for every
// tenant, since the change bus is process-global. Sized well above any realistic number of
// open browser tabs; excess connections get a 429 and fall back to polling (the client polls
// independently anyway — see index.html/mobile.html).
const MAX_SSE_CONNECTIONS = 500;
// Comment-only keep-alive so a dead/half-open connection is detected and reaped by the OS/proxy
// instead of lingering as a pinned listener forever.
const SSE_HEARTBEAT_MS = 30_000;

export function eventsRouter(): Router {
	const router = Router();
	let openConnections = 0;

	router.get("/", (req, res) => {
		if (openConnections >= MAX_SSE_CONNECTIONS) {
			res.status(429).json({ error: "Too many open event streams" });
			return;
		}
		openConnections += 1;

		res.setHeader("Content-Type", "text/event-stream");
		res.setHeader("Cache-Control", "no-cache");
		res.setHeader("Connection", "keep-alive");
		res.flushHeaders();

		const unsubscribe = onStateChanged(() => {
			res.write("data: refresh\n\n");
		});
		const heartbeat = setInterval(() => {
			res.write(": keep-alive\n\n");
		}, SSE_HEARTBEAT_MS);

		let closed = false;
		const cleanup = () => {
			if (closed) return;
			closed = true;
			clearInterval(heartbeat);
			unsubscribe();
			openConnections -= 1;
			res.end();
		};

		req.on("close", cleanup);
	});

	return router;
}
