import { describe, it, expect, afterEach } from "@jest/globals";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	clearCollaboratorSyncIssue,
	listCollaboratorSyncIssues,
	recordCollaboratorSyncFailure,
} from "../../src/engine/github/collaboratorSyncLog.js";
import type { CollaboratorSyncIssue } from "../../src/engine/github/collaboratorSyncLog.js";

function issueFixture(overrides: Partial<CollaboratorSyncIssue> = {}): CollaboratorSyncIssue {
	return {
		login: "bob",
		owner: "acme-corp",
		name: "widgets",
		action: "add",
		reason: "insufficient-permission",
		message: "missing permission",
		occurredAt: "2026-06-30T00:00:00.000Z",
		...overrides,
	};
}

describe("collaboratorSyncLog", () => {
	let dir: string;

	afterEach(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	async function tempPath(): Promise<string> {
		dir = await mkdtemp(join(tmpdir(), "quire-synclog-"));
		return join(dir, "collaborator-sync-issues.json");
	}

	it("returns an empty list when no file exists yet", async () => {
		const path = await tempPath();
		expect(await listCollaboratorSyncIssues(path)).toEqual([]);
	});

	it("records a failure and lists it back", async () => {
		const path = await tempPath();
		const issue = issueFixture();

		await recordCollaboratorSyncFailure(path, issue);

		expect(await listCollaboratorSyncIssues(path)).toEqual([issue]);
	});

	it("replaces a prior entry for the same (login, owner, name, action) instead of accumulating", async () => {
		const path = await tempPath();
		await recordCollaboratorSyncFailure(path, issueFixture({ reason: "github-error", message: "first" }));
		await recordCollaboratorSyncFailure(path, issueFixture({ reason: "insufficient-permission", message: "second" }));

		const issues = await listCollaboratorSyncIssues(path);
		expect(issues).toHaveLength(1);
		expect(issues[0]?.message).toBe("second");
	});

	it("keeps separate entries for different keys", async () => {
		const path = await tempPath();
		await recordCollaboratorSyncFailure(path, issueFixture({ login: "bob" }));
		await recordCollaboratorSyncFailure(path, issueFixture({ login: "alice" }));
		await recordCollaboratorSyncFailure(path, issueFixture({ login: "bob", action: "remove" }));
		await recordCollaboratorSyncFailure(path, issueFixture({ login: "bob", name: "gadgets" }));

		expect(await listCollaboratorSyncIssues(path)).toHaveLength(4);
	});

	it("clearing a resolved issue removes exactly that key, leaving others untouched", async () => {
		const path = await tempPath();
		await recordCollaboratorSyncFailure(path, issueFixture({ login: "bob" }));
		await recordCollaboratorSyncFailure(path, issueFixture({ login: "alice" }));

		await clearCollaboratorSyncIssue(path, "bob", "acme-corp", "widgets", "add");

		const issues = await listCollaboratorSyncIssues(path);
		expect(issues).toHaveLength(1);
		expect(issues[0]?.login).toBe("alice");
	});

	it("clearing a key with no matching issue is a no-op, not an error", async () => {
		const path = await tempPath();
		await expect(clearCollaboratorSyncIssue(path, "nobody", "acme-corp", "widgets", "add")).resolves.toBeUndefined();
		expect(await listCollaboratorSyncIssues(path)).toEqual([]);
	});

	it("caps the list at 50 entries, dropping the oldest", async () => {
		const path = await tempPath();
		for (let i = 0; i < 55; i++) {
			await recordCollaboratorSyncFailure(path, issueFixture({ login: `user-${i}` }));
		}
		const issues = await listCollaboratorSyncIssues(path);
		expect(issues).toHaveLength(50);
		expect(issues[0]?.login).toBe("user-5");
		expect(issues.at(-1)?.login).toBe("user-54");
	});
});
