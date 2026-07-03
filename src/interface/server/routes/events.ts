import { Router } from "express";
import { onStateChanged } from "../changeEvents.js";

// Mounted at /events, behind the same session gate as /prs, /bundles, /queue, /shelf (see
// index.ts). Push-side companion to those polling endpoints: emits a no-payload "refresh"
// event whenever server state changes so the browser doesn't have to wait for its next poll
// tick. The client still polls independently (see index.html/mobile.html) as a fallback for
// a dropped/unsupported connection — this is the fast path, not the only path.
export function eventsRouter(): Router {
	const router = Router();

	router.get("/", (req, res) => {
		res.setHeader("Content-Type", "text/event-stream");
		res.setHeader("Cache-Control", "no-cache");
		res.setHeader("Connection", "keep-alive");
		res.flushHeaders();

		const unsubscribe = onStateChanged(() => {
			res.write("data: refresh\n\n");
		});

		req.on("close", () => {
			unsubscribe();
			res.end();
		});
	});

	return router;
}
