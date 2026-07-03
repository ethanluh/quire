import { describe, it, expect } from "@jest/globals";
import {
	classifyHunk,
	extractConflictHunks,
	extractConflictRegions,
	reconstructContent,
	resolveMechanicalHunk,
} from "../../src/engine/queue/conflictHunks.js";

describe("extractConflictHunks", () => {
	it("returns no hunks when the three-way merge has no conflicting region", () => {
		// An unchanged line must separate the two edits, or diff3 treats them as one region
		// rather than two independent non-overlapping ones.
		const regions = extractConflictRegions("a-ours\nb\nc\nd", "a\nb\nc\nd", "a\nb\nc\nd-theirs");
		expect(extractConflictHunks(regions)).toEqual([]);
	});

	it("isolates just the conflicting region, leaving agreed lines out of the hunk", () => {
		const regions = extractConflictRegions("a\nb-A\nc", "a\nb\nc", "a\nb-B\nc");
		const hunks = extractConflictHunks(regions);

		expect(hunks).toHaveLength(1);
		expect(hunks[0]).toMatchObject({ oursLines: ["b-A"], baseLines: ["b"], theirsLines: ["b-B"] });
	});
});

describe("classifyHunk", () => {
	it("classifies a hunk as mechanical when ours and theirs agree modulo whitespace", () => {
		const regions = extractConflictRegions("a\nb-ours\nc", "a\nb\nc", "a\nb-ours \nc");
		const [hunk] = extractConflictHunks(regions);
		expect(hunk && classifyHunk(hunk)).toBe("mechanical");
	});

	it("classifies a hunk as semantic when ours and theirs genuinely disagree", () => {
		const regions = extractConflictRegions("a\nb-A\nc", "a\nb\nc", "a\nb-B\nc");
		const [hunk] = extractConflictHunks(regions);
		expect(hunk && classifyHunk(hunk)).toBe("semantic");
	});

	it("does not classify a whitespace change inside a string literal as mechanical", () => {
		// Collapsing internal whitespace runs (not just leading/trailing) would treat this as
		// formatting-only, but it's a real behavior change in the query string.
		const ours = 'const q = "select  *  from users";';
		const theirs = 'const q = "select * from users";';
		const regions = extractConflictRegions(`a\n${ours}\nc`, "a\nb\nc", `a\n${theirs}\nc`);
		const [hunk] = extractConflictHunks(regions);
		expect(hunk && classifyHunk(hunk)).toBe("semantic");
	});

	it("still classifies pure reindentation (leading whitespace only) as mechanical", () => {
		const regions = extractConflictRegions("a\n    b-ours\nc", "a\nb\nc", "a\n\tb-ours\nc");
		const [hunk] = extractConflictHunks(regions);
		expect(hunk && classifyHunk(hunk)).toBe("mechanical");
	});
});

describe("resolveMechanicalHunk", () => {
	it("favors ours (the incoming PR)", () => {
		const regions = extractConflictRegions("a\nb-ours\nc", "a\nb\nc", "a\nb-ours \nc");
		const [hunk] = extractConflictHunks(regions);
		expect(hunk && resolveMechanicalHunk(hunk)).toBe("b-ours");
	});
});

describe("reconstructContent", () => {
	it("reassembles agreed lines verbatim and substitutes the resolution for each conflict region", () => {
		const regions = extractConflictRegions("a\nb-A\nc\nd", "a\nb\nc\nd", "a\nb-B\nc\nd");
		const hunks = extractConflictHunks(regions);
		const resolutions = new Map<number, string>();
		for (const hunk of hunks) resolutions.set(hunk.index, "b-merged");

		expect(reconstructContent(regions, resolutions)).toBe("a\nb-merged\nc\nd");
	});

	it("throws if a conflict region has no resolution provided", () => {
		const regions = extractConflictRegions("a\nb-A\nc", "a\nb\nc", "a\nb-B\nc");
		expect(() => reconstructContent(regions, new Map())).toThrow(/No resolution provided/);
	});
});
