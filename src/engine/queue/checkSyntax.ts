import ts from "typescript";

const SCRIPT_KIND_BY_EXTENSION: ReadonlyMap<string, ts.ScriptKind> = new Map([
	[".ts", ts.ScriptKind.TS],
	[".tsx", ts.ScriptKind.TSX],
	[".js", ts.ScriptKind.JS],
	[".jsx", ts.ScriptKind.JSX],
	[".mjs", ts.ScriptKind.JS],
	[".cjs", ts.ScriptKind.JS],
]);

function extensionOf(path: string): string {
	const dot = path.lastIndexOf(".");
	return dot === -1 ? "" : path.slice(dot).toLowerCase();
}

// Best-effort parse sanity check, not a build: catches truncated/garbled LLM output
// (unbalanced braces, cut-off statements) without requiring full project context or a
// sandboxed build. Only checks syntax, never types. Unsupported extensions return
// undefined rather than failing closed — this check is one extra signal, not a gate
// every language must pass.
export function checkSyntax(path: string, content: string): string | undefined {
	const scriptKind = SCRIPT_KIND_BY_EXTENSION.get(extensionOf(path));
	if (scriptKind === undefined) return undefined;

	const { diagnostics } = ts.transpileModule(content, {
		fileName: path,
		reportDiagnostics: true,
		compilerOptions: { allowJs: true, noEmit: true },
	});

	const first = diagnostics?.[0];
	if (first === undefined) return undefined;

	const message = ts.flattenDiagnosticMessageText(first.messageText, " ");
	if (first.file !== undefined && first.start !== undefined) {
		const { line } = first.file.getLineAndCharacterOfPosition(first.start);
		return `${message} (line ${line + 1})`;
	}
	return message;
}
