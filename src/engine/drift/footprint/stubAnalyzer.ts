import type { Bundle, Diff, SymbolRef, SymbolTouch } from "../../types/core.js";
import type { StaticAnalyzer } from "./analyzer.js";

export class StubStaticAnalyzer implements StaticAnalyzer {
	readonly language = "stub";
	private symbolsResult: ReadonlyArray<SymbolRef> = [];
	private footprintResult: ReadonlyArray<string> = [];
	private symbolTouchesResult: ReadonlyArray<SymbolTouch> = [];

	setSymbols(symbols: ReadonlyArray<SymbolRef>): void {
		this.symbolsResult = symbols;
	}

	setFootprint(files: ReadonlyArray<string>): void {
		this.footprintResult = files;
	}

	setSymbolTouches(touches: ReadonlyArray<SymbolTouch>): void {
		this.symbolTouchesResult = touches;
	}

	async analyzeSymbols(_diff: Diff): Promise<ReadonlyArray<SymbolRef>> {
		return this.symbolsResult;
	}

	async computeExpectedFootprint(_bundle: Bundle, _screenedPrId: string): Promise<ReadonlyArray<string>> {
		return this.footprintResult;
	}

	async analyzeSymbolTouches(_diff: Diff): Promise<ReadonlyArray<SymbolTouch>> {
		return this.symbolTouchesResult;
	}
}
