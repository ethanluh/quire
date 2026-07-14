import { readJsonFile, writeJsonFileAtomic } from "../jsonFile.js";
import type { GateCriterion, GateMode } from "../types/gate.js";

export interface GateConfigOverride {
	criteria: ReadonlyArray<GateCriterion>;
}

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

function isGateConfigOverride(value: unknown): value is GateConfigOverride {
	return (
		typeof value === "object" &&
		value !== null &&
		Array.isArray((value as Record<string, unknown>)["criteria"]) &&
		(value as { criteria: unknown[] }).criteria.every(isGateCriterion)
	);
}

// Per-team override of the platform-wide default gate criteria modes (index.ts's
// pipelineConfig.gate.criteria). Absent file, or a criterion name the override doesn't
// list, means "inherit the platform default for that criterion" — this store only ever
// holds the delta a team owner/admin explicitly set via PATCH /admin/gate-config.
export class GateConfigStore {
	private override: GateConfigOverride | undefined;

	constructor(private readonly statePath: string) {}

	async load(): Promise<void> {
		this.override = await readJsonFile(this.statePath, isGateConfigOverride);
	}

	get(): GateConfigOverride | undefined {
		return this.override;
	}

	async set(override: GateConfigOverride): Promise<void> {
		await writeJsonFileAtomic(this.statePath, override);
		this.override = override;
	}
}

// Resolves the effective per-criterion mode: an override wins for any criterion name it
// explicitly lists; every other criterion falls back to the platform default. A defined
// override with an empty criteria list is equivalent to no override at all — this is also
// how a team admin resets back to the platform default via PATCH.
export function resolveEffectiveGateConfig(
	platformDefault: ReadonlyArray<GateCriterion>,
	override: GateConfigOverride | undefined,
): ReadonlyArray<GateCriterion> {
	if (override === undefined) return platformDefault;
	const overrides = new Map(override.criteria.map((c) => [c.name, c.mode] as const));
	return platformDefault.map((c) => ({ name: c.name, mode: overrides.get(c.name) ?? c.mode }));
}
