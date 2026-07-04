import { describe, it, expect } from "@jest/globals";
import { createAccountState, installationForRepo, repoBinding } from "../../src/interface/server/accountState.js";
import type { InstallationBinding, RepoBinding } from "../../src/engine/github/installation.js";

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

function repo(overrides: Partial<RepoBinding> = {}): RepoBinding {
	return { owner: "octocat", name: "widgets", installationId: 42, addedAt: "2026-06-30T00:00:00.000Z", addedBy: "alice", ...overrides };
}

describe("createAccountState", () => {
	it("defaults to an empty installations/repos list when given no initial state", () => {
		const state = createAccountState(undefined);

		expect(state.current).toEqual({ installations: [], repos: [] });
	});

	it("preserves an initial state as-is", () => {
		const initial = { installations: [BINDING_A], repos: [repo()] };

		const state = createAccountState(initial);

		expect(state.current).toBe(initial);
	});
});

describe("repoBinding", () => {
	it("returns undefined when the repo isn't watched", () => {
		expect(repoBinding({ installations: [BINDING_A], repos: [] }, "octocat", "widgets")).toBeUndefined();
	});

	it("returns the matching binding among several watched repos", () => {
		const acmeRepo = repo({ owner: "acme-corp", name: "gadgets", installationId: 43 });
		const state = { installations: [BINDING_A, BINDING_B], repos: [repo(), acmeRepo] };

		expect(repoBinding(state, "acme-corp", "gadgets")).toEqual(acmeRepo);
	});
});

describe("installationForRepo", () => {
	it("returns undefined when the repo isn't watched", () => {
		expect(installationForRepo({ installations: [BINDING_A, BINDING_B], repos: [] }, "octocat", "widgets")).toBeUndefined();
	});

	it("returns the installation backing a watched repo, among several bound installations", () => {
		const state = { installations: [BINDING_A, BINDING_B], repos: [repo({ owner: "acme-corp", name: "widgets", installationId: 43 })] };

		expect(installationForRepo(state, "acme-corp", "widgets")).toEqual(BINDING_B);
	});

	it("returns undefined when the repo's owning installation is no longer bound", () => {
		const state = { installations: [BINDING_A], repos: [repo({ owner: "acme-corp", name: "widgets", installationId: 43 })] };

		expect(installationForRepo(state, "acme-corp", "widgets")).toBeUndefined();
	});
});
