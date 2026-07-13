import { EventEmitter } from "node:events";

// A no-payload "something changed, go re-fetch" signal, scoped per team. Consumers
// (routes/events.ts's SSE connections) already re-fetch and diff their own tenant-scoped
// data themselves, so this only needs to wake up that team's connections, not carry what
// changed or reach any other team.
// One emitter per team, created lazily and kept for the life of the process — same
// lifetime as TenantRegistry's own per-team map, which this mirrors.
const emitters = new Map<string, EventEmitter>();

function getEmitter(teamId: string): EventEmitter {
	let emitter = emitters.get(teamId);
	if (emitter === undefined) {
		emitter = new EventEmitter();
		// One listener per open SSE connection for this team. Bounded a little above the
		// per-team SSE connection cap (MAX_SSE_CONNECTIONS in routes/events.ts) rather than
		// 0/unlimited, so a genuine listener leak still trips Node's warning instead of being
		// silently masked.
		emitter.setMaxListeners(600);
		emitters.set(teamId, emitter);
	}
	return emitter;
}

export function notifyStateChanged(teamId: string): void {
	getEmitter(teamId).emit("changed");
}

export function onStateChanged(teamId: string, listener: () => void): () => void {
	const emitter = getEmitter(teamId);
	emitter.on("changed", listener);
	return () => emitter.off("changed", listener);
}
