import { createKeyedLock } from "./keyedLock.js";

// Serializes every operation that reads or writes a team's installation.json against every
// other such operation for the same team. Without this, a collaborator-sync read (see
// collaborators.ts's callers in team.ts/githubApp.ts) can race a concurrent repo bind/unbind
// write in githubApp.ts — e.g. adding a new member to a repo the team is simultaneously
// unbinding, because the read landed on the pre-unbind snapshot. Keyed by teamId rather than
// installationPath so both call sites can share one lock without needing to agree on path
// construction. Mirrors teamStore.ts's own per-key promise-chaining lock, kept as a separate
// module since it guards a different file (installation.json, not members.json/
// membership.json) with different, unrelated callers.
export const withInstallationLock = createKeyedLock();
