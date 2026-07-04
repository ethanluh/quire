import { describe, it, expect } from "@jest/globals";
import { checkSyntax } from "../../src/engine/queue/checkSyntax.js";

describe("checkSyntax", () => {
	it("returns undefined for syntactically valid TypeScript", () => {
		expect(checkSyntax("src/foo.ts", "export function add(a: number, b: number): number {\n\treturn a + b;\n}\n")).toBeUndefined();
	});

	it("returns undefined for syntactically valid JavaScript", () => {
		expect(checkSyntax("src/foo.js", "function add(a, b) {\n\treturn a + b;\n}\n")).toBeUndefined();
	});

	it("reports a parse error, including the line number, for truncated/garbled content", () => {
		const error = checkSyntax("src/foo.ts", "export function add(a: number, b: number): number {\n\treturn a + b;\n");
		expect(error).toBeDefined();
		expect(error).toMatch(/line \d+/);
	});

	it("reports a parse error for an unbalanced brace", () => {
		const error = checkSyntax("src/foo.tsx", "function App() {\n\treturn <div>{\n}\n");
		expect(error).toBeDefined();
	});

	it("returns undefined for unsupported extensions rather than failing closed", () => {
		expect(checkSyntax("src/foo.py", "def add(a, b:\n  return a + b")).toBeUndefined();
		expect(checkSyntax("README.md", "# not code at all {{{")).toBeUndefined();
	});
});
