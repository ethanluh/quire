export type CiOutcome = "success" | "failure" | "inconclusive";

// GitHub check_suite conclusions: "success" is unambiguous. "failure"/"timed_out" are clear,
// actionable CI failures — worth an immediate revert. Everything else ("neutral",
// "cancelled", "skipped", "action_required", "stale", still in progress, or unrecognized) is
// deliberately NOT treated as a failure: none of those mean the code is actually broken, and
// per the resolved VERIFY design, absence of a failure signal is never proof of success —
// it's "inconclusive," which escalates to a human without ever auto-declaring victory or
// triggering a revert over, say, someone cancelling an unrelated workflow run.
const CLEAR_FAILURE_CONCLUSIONS: ReadonlySet<string> = new Set(["failure", "timed_out"]);

export function ciOutcomeFromCheckSuiteConclusion(conclusion: string | undefined): CiOutcome {
	if (conclusion === "success") return "success";
	if (conclusion !== undefined && CLEAR_FAILURE_CONCLUSIONS.has(conclusion)) return "failure";
	return "inconclusive";
}

export type HealthCheckOutcome = "healthy" | "unhealthy" | "unreachable";

export interface HealthCheckConfig {
	url: string;
	maxAttempts?: number;
	delayMs?: number;
	timeoutMs?: number;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// Read-only — a single GET, never a deploy/build command (see docs/judge-integration-map.md
// §7: VERIFY is deliberately read-only; Quire never executes commands). Retries absorb
// ordinary deploy lag (a machine still booting behind a load balancer, briefly returning
// connection-refused or a 502) without treating that ambiguity as either a pass or a fail.
//
// The distinction that matters for the caller: any attempt that got a real (even bad) HTTP
// response means the deploy is reachable and unhealthy — that's an actionable signal worth
// reverting over. Every attempt failing at the network level (timeout, DNS, connection
// refused throughout) means we genuinely don't know, which must never trigger a revert.
export async function performHealthCheck(config: HealthCheckConfig): Promise<HealthCheckOutcome> {
	const attempts = config.maxAttempts ?? 3;
	const delayMs = config.delayMs ?? 2000;
	const timeoutMs = config.timeoutMs ?? 5000;

	let lastResponseStatus: number | undefined;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			const res = await fetch(config.url, { signal: AbortSignal.timeout(timeoutMs) });
			if (res.ok) return "healthy";
			lastResponseStatus = res.status;
		} catch {
			lastResponseStatus = undefined;
		}
		if (attempt < attempts) await sleep(delayMs);
	}
	return lastResponseStatus !== undefined ? "unhealthy" : "unreachable";
}
