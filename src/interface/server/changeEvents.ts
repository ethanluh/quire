import { EventEmitter } from "node:events";

// A no-payload "something changed, go re-fetch" signal. Consumers (routes/events.ts's SSE
// connections) already re-fetch and diff the actual data themselves, so this only needs to
// wake them up, not carry what changed.
const emitter = new EventEmitter();
// One listener per open SSE connection. Bounded a little above the SSE connection cap
// (MAX_SSE_CONNECTIONS in routes/events.ts) rather than 0/unlimited, so a genuine listener
// leak still trips Node's warning instead of being silently masked.
emitter.setMaxListeners(600);

export function notifyStateChanged(): void {
	emitter.emit("changed");
}

export function onStateChanged(listener: () => void): () => void {
	emitter.on("changed", listener);
	return () => emitter.off("changed", listener);
}
