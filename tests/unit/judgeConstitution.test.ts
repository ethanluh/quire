import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConstitution } from "../../src/engine/judge/constitution.js";

const START = "<!-- judge-constitution:config:start -->";
const END = "<!-- judge-constitution:config:end -->";

function wrapConfig(config: unknown): string {
	return `# Judge Constitution\n\nsome prose\n\n${START}\n\`\`\`json\n${JSON.stringify(config, null, 2)}\n\`\`\`\n${END}\n`;
}

const VALID_CONFIG = {
	version: 1,
	rubric: [
		{ key: "direction", label: "Direction alignment", bands: [{ minScore: 0, maxScore: 1, description: "x" }] },
		{ key: "drift", label: "Drift honesty", bands: [{ minScore: 0, maxScore: 1, description: "x" }] },
		{ key: "blastRadius", label: "Blast radius", bands: [{ minScore: 0, maxScore: 1, description: "x" }] },
		{ key: "reversibility", label: "Reversibility", bands: [{ minScore: 0, maxScore: 1, description: "x" }] },
		{ key: "precedent", label: "Precedent match", bands: [{ minScore: 0, maxScore: 1, description: "x" }] },
	],
	riskTaxonomy: [{ id: "auth", label: "Auth", description: "d", filePatterns: ["(?:^|/)auth/"] }],
	thresholds: { autoAcceptConfidence: 0.9, autoRejectConfidence: 0.95, maxBlastRadiusAuto: 15 },
};

describe("loadConstitution", () => {
	let dir: string;

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-judge-constitution-"));
	});

	afterAll(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	async function writeAndLoad(config: unknown, filename = "constitution.md"): Promise<ReturnType<typeof loadConstitution>> {
		const path = join(dir, filename);
		await writeFile(path, wrapConfig(config), "utf8");
		return loadConstitution(path);
	}

	it("loads a valid constitution with every rubric criterion present", async () => {
		const constitution = await writeAndLoad(VALID_CONFIG, "valid.md");
		expect(constitution.version).toBe(1);
		expect(constitution.rubric).toHaveLength(5);
		expect(constitution.thresholds.autoAcceptConfidence).toBe(0.9);
	});

	it("compiles risk taxonomy file patterns into real RegExp instances", async () => {
		const constitution = await writeAndLoad(VALID_CONFIG, "compiled.md");
		const authEntry = constitution.riskTaxonomy.find((e) => e.id === "auth");
		expect(authEntry?.filePatterns[0]).toBeInstanceOf(RegExp);
		expect(authEntry?.filePatterns[0]?.test("src/auth/session.ts")).toBe(true);
	});

	it("throws when the config markers are missing entirely", async () => {
		const path = join(dir, "no-markers.md");
		await writeFile(path, "# Judge Constitution\n\nno config block here\n", "utf8");
		await expect(loadConstitution(path)).rejects.toThrow(/could not find/);
	});

	it("throws on invalid JSON inside the config block", async () => {
		const path = join(dir, "bad-json.md");
		await writeFile(path, `${START}\n\`\`\`json\n{ not valid json\n\`\`\`\n${END}\n`, "utf8");
		await expect(loadConstitution(path)).rejects.toThrow(/not valid JSON/);
	});

	it("throws when a rubric criterion is missing", async () => {
		const incomplete = { ...VALID_CONFIG, rubric: VALID_CONFIG.rubric.filter((c) => c.key !== "precedent") };
		await expect(writeAndLoad(incomplete, "missing-criterion.md")).rejects.toThrow(/missing required criterion/);
	});

	it("throws when a rubric criterion is duplicated", async () => {
		const duplicated = { ...VALID_CONFIG, rubric: [...VALID_CONFIG.rubric, VALID_CONFIG.rubric[0]] };
		await expect(writeAndLoad(duplicated, "duplicate-criterion.md")).rejects.toThrow(/listed more than once/);
	});

	it("throws when autoRejectConfidence is not greater than autoAcceptConfidence", async () => {
		const badThresholds = {
			...VALID_CONFIG,
			thresholds: { autoAcceptConfidence: 0.9, autoRejectConfidence: 0.9, maxBlastRadiusAuto: 15 },
		};
		await expect(writeAndLoad(badThresholds, "bad-thresholds.md")).rejects.toThrow(/autoRejectConfidence must be greater/);
	});

	it("throws when a risk taxonomy file pattern is not a valid regex", async () => {
		const badPattern = {
			...VALID_CONFIG,
			riskTaxonomy: [{ id: "broken", label: "Broken", description: "d", filePatterns: ["(unterminated"] }],
		};
		await expect(writeAndLoad(badPattern, "bad-pattern.md")).rejects.toThrow(/invalid file pattern/);
	});

	it("throws a descriptive error when the file does not exist", async () => {
		await expect(loadConstitution(join(dir, "does-not-exist.md"))).rejects.toThrow(/could not read/);
	});

	it("loads the real docs/judge-constitution.md shipped with the repo", async () => {
		const constitution = await loadConstitution(join(process.cwd(), "docs/judge-constitution.md"));
		expect(constitution.rubric).toHaveLength(5);
		expect(constitution.riskTaxonomy.length).toBeGreaterThan(0);
		expect(constitution.thresholds.autoRejectConfidence).toBeGreaterThan(constitution.thresholds.autoAcceptConfidence);
	});
});
