import { EventEmitter } from "node:events";

// A no-payload "something changed, go re-fetch" signal. Consumers (routes/events.ts's SSE
// connections) already re-fetch and diff the actual data themselves, so this only needs to
// wake them up, not carry what changed.
const emitter = new EventEmitter();
emitter.setMaxListeners(0); // one listener per open SSE connection, unbounded by design

export function notifyStateChanged(): void {
	emitter.emit("changed");
}

export function onStateChanged(listener: () => void): () => void {
	emitter.on("changed", listener);
	return () => emitter.off("changed", listener);
}
