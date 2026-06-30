import type { GitHubClient, RawPRPayload } from "../../src/engine/github/client.js";
export declare class StubGitHubClient implements GitHubClient {
    private readonly prFixtures;
    readonly mergedPrs: string[];
    readonly revertedPrs: string[];
    addFixture(owner: string, repo: string, pr: RawPRPayload): void;
    getPullRequest(owner: string, repo: string, prNumber: number): Promise<RawPRPayload>;
    listOpenPullRequests(owner: string, repo: string): Promise<ReadonlyArray<RawPRPayload>>;
    mergePullRequest(owner: string, repo: string, prNumber: number): Promise<void>;
    revertPullRequest(owner: string, repo: string, prNumber: number): Promise<string>;
}
