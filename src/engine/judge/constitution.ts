import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { CompiledRiskTaxonomyEntry, JudgeConstitution, RubricCriterionKey } from "../types/judge.js";
import { stripCodeFence } from "../drift/effectList/stripCodeFence.js";
import { errorMessage } from "../util/error.js";

const CONFIG_START_MARKER = "<!-- judge-constitution:config:start -->";
const CONFIG_END_MARKER = "<!-- judge-constitution:config:end -->";

const RUBRIC_CRITERION_KEYS: ReadonlyArray<RubricCriterionKey> = [
	"direction",
	"drift",
	"blastRadius",
	"reversibility",
	"precedent",
];

const scoreBandSchema = z
	.object({
		minScore: z.number().min(0).max(1),
		maxScore: z.number().min(0).max(1),
		description: z.string().min(1),
	})
	.refine((band) => band.minScore < band.maxScore, { message: "a score band's minScore must be less than its maxScore" });

const rubricCriterionSchema = z.object({
	key: z.enum(RUBRIC_CRITERION_KEYS as [RubricCriterionKey, ...RubricCriterionKey[]]),
	label: z.string().min(1),
	bands: z.array(scoreBandSchema).min(1),
});

const riskTaxonomyEntrySchema = z.object({
	id: z.string().min(1),
	label: z.string().min(1),
	description: z.string().min(1),
	filePatterns: z.array(z.string()),
});

const thresholdsSchema = z
	.object({
		autoAcceptConfidence: z.number().min(0).max(1),
		autoRejectConfidence: z.number().min(0).max(1),
		maxBlastRadiusAuto: z.number().min(0),
	})
	// A wrong auto-reject costs a swarm regeneration cycle; a wrong auto-accept sits
	// reversibly in the merge queue until it lands. Reject must require strictly more
	// confidence than accept, or the asymmetry the constitution document describes is
	// just prose nobody enforces.
	.refine((t) => t.autoRejectConfidence > t.autoAcceptConfidence, {
		message: "thresholds.autoRejectConfidence must be greater than thresholds.autoAcceptConfidence",
	});

const constitutionConfigSchema = z.object({
	version: z.number().int().min(1),
	rubric: z.array(rubricCriterionSchema).min(1),
	riskTaxonomy: z.array(riskTaxonomyEntrySchema),
	thresholds: thresholdsSchema,
});

// Every RubricCriterionKey must appear exactly once — bundleJudge.ts (Phase 2) builds its
// prompt by iterating this list and would otherwise silently omit a criterion the rest of
// the constitution document describes, or crash on a duplicate.
function assertCompleteRubric(rubric: ReadonlyArray<{ key: RubricCriterionKey }>): void {
	const seen = new Set<RubricCriterionKey>();
	for (const criterion of rubric) {
		if (seen.has(criterion.key)) {
			throw new Error(`Judge constitution: rubric criterion "${criterion.key}" is listed more than once`);
		}
		seen.add(criterion.key);
	}
	const missing = RUBRIC_CRITERION_KEYS.filter((key) => !seen.has(key));
	if (missing.length > 0) {
		throw new Error(`Judge constitution: rubric is missing required criterion/criteria: ${missing.join(", ")}`);
	}
}

// Compiles every taxonomy entry's file patterns once at load time — riskTaxonomy.ts matches
// against the compiled form on every bundle, never re-compiling per call. A single invalid
// regex anywhere in the document fails the whole load with the offending entry/pattern named,
// rather than silently skipping it or throwing later at match time.
function compileRiskTaxonomy(
	entries: ReadonlyArray<{ id: string; label: string; description: string; filePatterns: ReadonlyArray<string> }>,
): ReadonlyArray<CompiledRiskTaxonomyEntry> {
	return entries.map((entry) => ({
		id: entry.id,
		label: entry.label,
		description: entry.description,
		filePatterns: entry.filePatterns.map((pattern) => {
			try {
				return new RegExp(pattern, "i");
			} catch (err) {
				throw new Error(
					`Judge constitution: risk taxonomy entry "${entry.id}" has an invalid file pattern "${pattern}": ${errorMessage(err)}`,
				);
			}
		}),
	}));
}

function extractConfigJson(markdown: string): string {
	const startIndex = markdown.indexOf(CONFIG_START_MARKER);
	const endIndex = markdown.indexOf(CONFIG_END_MARKER);
	if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
		throw new Error(
			`Judge constitution: could not find a "${CONFIG_START_MARKER}" ... "${CONFIG_END_MARKER}" machine-readable config block`,
		);
	}
	const between = markdown.slice(startIndex + CONFIG_START_MARKER.length, endIndex);
	return stripCodeFence(between);
}

// Parses and validates docs/judge-constitution.md's embedded config into a typed
// JudgeConstitution. Throws (never returns a partial/best-guess result) on any structural
// problem — a malformed constitution must block the judge from running at all, the same way
// a malformed model response in semanticHunkResolver.ts fails closed rather than guessing.
export async function loadConstitution(path: string): Promise<JudgeConstitution> {
	let markdown: string;
	try {
		markdown = await readFile(path, "utf8");
	} catch (err) {
		throw new Error(`Judge constitution: could not read ${path}: ${errorMessage(err)}`);
	}

	const configJson = extractConfigJson(markdown);

	let parsedJson: unknown;
	try {
		parsedJson = JSON.parse(configJson);
	} catch (err) {
		throw new Error(`Judge constitution: embedded config block at ${path} is not valid JSON: ${errorMessage(err)}`);
	}

	const result = constitutionConfigSchema.safeParse(parsedJson);
	if (!result.success) {
		throw new Error(`Judge constitution: embedded config block at ${path} failed validation: ${result.error.message}`);
	}

	assertCompleteRubric(result.data.rubric);

	return {
		version: result.data.version,
		rubric: result.data.rubric,
		riskTaxonomy: compileRiskTaxonomy(result.data.riskTaxonomy),
		thresholds: result.data.thresholds,
	};
}
