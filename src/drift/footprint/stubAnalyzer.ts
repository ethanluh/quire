import type { Bundle, Diff, SymbolRef } from "../../types/core.js";
import type { StaticAnalyzer } from "./analyzer.js";

export class StubStaticAnalyzer implements StaticAnalyzer {
	readonly language = "stub";
	private symbolsResult: ReadonlyArray<SymbolRef> = [];
	private footprintResult: ReadonlyArray<string> = [];

	setSymbols(symbols: ReadonlyArray<SymbolRef>): void {
		this.symbolsResult = symbols;
	}

	setFootprint(files: ReadonlyArray<string>): void {
		this.footprintResult = files;
	}

	async analyzeSymbols(_diff: Diff): Promise<ReadonlyArray<SymbolRef>> {
		return this.symbolsResult;
	}

	async computeExpectedFootprint(_bundle: Bundle): Promise<ReadonlyArray<string>> {
		return this.footprintResult;
	}
}
