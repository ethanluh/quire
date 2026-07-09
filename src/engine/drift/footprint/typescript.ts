import type { Bundle, Diff, SymbolRef, SymbolTouch } from "../../types/core.js";
import type { StaticAnalyzer } from "./analyzer.js";

// Shared between EXPORT_RE and EXPORT_REMOVE_RE below so the declaration-keyword list only
// has to be updated in one place (e.g. adding "namespace"/"abstract" support later).
const EXPORT_DECL_KEYWORDS = "(?:default|const|let|var|function|class|type|interface|enum|async)";
const EXPORT_RE = new RegExp(`^\\+\\s*export\\s+(?:${EXPORT_DECL_KEYWORDS}\\s+)*(\\w+)`);
const IMPORT_RE = /^\+\s*import\s+.*from\s+['"]([^'"]+)['"]/;

// Same declaration shape as EXPORT_RE, anchored on a removed line instead of an added one.
const EXPORT_REMOVE_RE = new RegExp(`^-\\s*export\\s+(?:${EXPORT_DECL_KEYWORDS}\\s+)*(\\w+)`);

// Distinct from IMPORT_RE above, which captures the module path (used for footprintAnomaly's
// file-set check) rather than the imported identifier. These capture identifiers so
// symbol-coherence checking can tell whether a PR still expects a given name to exist.
// v1 known gap: misses multi-line imports, `import * as ns`, and re-exports.
const NAMED_IMPORT_RE = /^\+\s*import\s+(?:type\s+)?(?:\w+\s*,\s*)?\{([^}]+)\}\s*from\s+['"]/;
const DEFAULT_IMPORT_RE = /^\+\s*import\s+(?:type\s+)?(\w+)\s*(?:,\s*\{[^}]*\})?\s*from\s+['"]/;

export class TypeScriptAnalyzer implements StaticAnalyzer {
	readonly language = "typescript";

	async analyzeSymbols(diff: Diff): Promise<ReadonlyArray<SymbolRef>> {
		const symbols: SymbolRef[] = [];

		for (const hunk of diff.hunks) {
			for (const line of hunk.additions) {
				const exportMatch = EXPORT_RE.exec(line);
				if (exportMatch?.[1] !== undefined) {
					symbols.push({
						name: exportMatch[1],
						filePath: hunk.filePath,
						kind: "export",
					});
				}

				const importMatch = IMPORT_RE.exec(line);
				if (importMatch?.[1] !== undefined) {
					symbols.push({
						name: importMatch[1],
						filePath: hunk.filePath,
						kind: "variable",
					});
				}
			}
		}

		return symbols;
	}

	async computeExpectedFootprint(bundle: Bundle): Promise<ReadonlyArray<string>> {
		const files = new Set<string>();
		for (const member of bundle.members) {
			for (const f of member.filesTouched) {
				files.add(f);
			}
		}
		return [...files];
	}

	// Rename-pairing (matching a removed export against an added one in the same hunk) is
	// deliberately not attempted here: a same-hunk "one removed + one added ⇒ rename"
	// heuristic misfires on any hunk with an unrelated add/remove pair (common in refactors).
	// It's also unnecessary — an untagged remove-of-old-name + add-of-new-name pair already
	// trips findSymbolInconsistencies via plain "remove"/"reference" facts.
	async analyzeSymbolTouches(diff: Diff): Promise<ReadonlyArray<SymbolTouch>> {
		const touches: SymbolTouch[] = [];

		for (const hunk of diff.hunks) {
			for (const line of hunk.additions) {
				const exportMatch = EXPORT_RE.exec(line);
				if (exportMatch?.[1] !== undefined) {
					touches.push({ name: exportMatch[1], filePath: hunk.filePath, kind: "export", operation: "add" });
				}

				const namedImportMatch = NAMED_IMPORT_RE.exec(line);
				if (namedImportMatch?.[1] !== undefined) {
					for (const rawName of namedImportMatch[1].split(",")) {
						// Strip an inline per-specifier "type" modifier (`{ type Foo, Bar }`)
						// after stripping any alias — otherwise the recorded name is the
						// garbage string "type Foo", which can never join the "Foo" face in
						// findSymbolInconsistencies and silently drops the reference touch.
						const beforeAlias = rawName.trim().split(/\s+as\s+/)[0]?.trim();
						const name = beforeAlias?.replace(/^type\s+/, "");
						if (name !== undefined && name.length > 0) {
							touches.push({ name, filePath: hunk.filePath, kind: "variable", operation: "reference" });
						}
					}
				}

				const defaultImportMatch = DEFAULT_IMPORT_RE.exec(line);
				if (defaultImportMatch?.[1] !== undefined) {
					touches.push({
						name: defaultImportMatch[1],
						filePath: hunk.filePath,
						kind: "variable",
						operation: "reference",
					});
				}
			}

			for (const line of hunk.deletions) {
				const exportMatch = EXPORT_REMOVE_RE.exec(line);
				if (exportMatch?.[1] !== undefined) {
					touches.push({ name: exportMatch[1], filePath: hunk.filePath, kind: "export", operation: "remove" });
				}
			}
		}

		return touches;
	}
}
