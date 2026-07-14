import { readJsonFile, writeJsonFileAtomic } from "../jsonFile.js";
import type { GateCriterion, GateMode } from "../types/gate.js";

function isGateMode(value: unknown): value is GateMode {
	return value === "enforce" || value === "shadow" || value === "off";
}

function isGateCriterion(value: unknown): value is GateCriterion {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as Record<string, unknown>)["name"] === "string" &&
		isGateMode((value as Record<string, unknown>)["mode"])
	);
}

function isGateCriterionList(value: unknown): value is ReadonlyArray<GateCriterion> {
	return Array.isArray(value) && value.every(isGateCriterion);
}

// The platform-wide default every team's own GateConfigStore override (see
// gateConfigStore.ts) falls back to. Previously a literal hardcoded in index.ts; this
// makes it editable at runtime by whoever operates this Quire instance, via
// PATCH /platform-admin/gate-config. Absent file means "never edited yet" — the caller
// (index.ts) is responsible for seeding it with the historical hardcoded default on first
// boot, so there is never an ambiguous "no default at all" state once the process is up.
export class PlatformGateDefaultsStore {
	private criteria: ReadonlyArray<GateCriterion> | undefined;

	constructor(private readonly statePath: string) {}

	async load(): Promise<void> {
		this.criteria = await readJsonFile(this.statePath, isGateCriterionList);
	}

	get(): ReadonlyArray<GateCriterion> | undefined {
		return this.criteria;
	}

	async set(criteria: ReadonlyArray<GateCriterion>): Promise<void> {
		await writeJsonFileAtomic(this.statePath, criteria);
		this.criteria = criteria;
	}
}
