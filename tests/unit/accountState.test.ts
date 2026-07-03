import { describe, it, expect } from "@jest/globals";
import { createAccountState, activeInstallation } from "../../src/interface/server/accountState.js";
import type { InstallationBinding } from "../../src/engine/github/installation.js";

const BINDING_A: InstallationBinding = {
	installationId: 42,
	accountLogin: "octocat",
	accountType: "Organization",
	boundAt: "2026-06-30T00:00:00.000Z",
};

const BINDING_B: InstallationBinding = {
	installationId: 43,
	accountLogin: "acme-corp",
	accountType: "Organization",
	boundAt: "2026-06-30T00:00:00.000Z",
};

describe("createAccountState", () => {
	it("defaults to an empty installations list when given no initial state", () => {
		const state = createAccountState(undefined);

		expect(state.current).toEqual({ installations: [] });
	});

	it("preserves an initial state as-is", () => {
		const initial = { installations: [BINDING_A], selectedRepo: { owner: "octocat", name: "widgets", installationId: 42 } };

		const state = createAccountState(initial);

		expect(state.current).toBe(initial);
	});
});

describe("activeInstallation", () => {
	it("returns undefined when nothing is selected", () => {
		expect(activeInstallation({ installations: [BINDING_A, BINDING_B] })).toBeUndefined();
	});

	it("returns the installation backing the selected repo, among several bound installations", () => {
		const state = {
			installations: [BINDING_A, BINDING_B],
			selectedRepo: { owner: "acme-corp", name: "widgets", installationId: 43 },
		};

		expect(activeInstallation(state)).toEqual(BINDING_B);
	});

	it("returns undefined when the selection's owning installation is no longer bound", () => {
		const state = {
			installations: [BINDING_A],
			selectedRepo: { owner: "acme-corp", name: "widgets", installationId: 43 },
		};

		expect(activeInstallation(state)).toBeUndefined();
	});
});
