import type { Bundle, Diff, SymbolRef } from "../../types/core.js";
import type { StaticAnalyzer } from "./analyzer.js";

const EXPORT_RE = /^\+\s*export\s+(?:(?:default|const|let|var|function|class|type|interface|enum|async)\s+)*(\w+)/;
const IMPORT_RE = /^\+\s*import\s+.*from\s+['"]([^'"]+)['"]/;

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
}
