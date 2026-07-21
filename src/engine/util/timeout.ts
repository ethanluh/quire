// Races `promise` against a deadline so a caller that can hang forever (an unbounded
// network call, a stuck lock) always gets a settled result. `promise` itself keeps running
// after the deadline fires — this only bounds how long the *caller* waits, it doesn't
// cancel the underlying work.
export async function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(onTimeout()), ms);
	});
	try {
		return await Promise.race([promise, deadline]);
	} finally {
		clearTimeout(timer!);
	}
}
