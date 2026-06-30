import type { GitHubClient, RawPRPayload } from "../../src/github/client.js";

export class StubGitHubClient implements GitHubClient {
	private readonly prFixtures: Map<string, RawPRPayload> = new Map();
	readonly mergedPrs: string[] = [];
	readonly revertedPrs: string[] = [];

	addFixture(owner: string, repo: string, pr: RawPRPayload): void {
		this.prFixtures.set(`${owner}/${repo}/${pr.number}`, pr);
	}

	async getPullRequest(owner: string, repo: string, prNumber: number): Promise<RawPRPayload> {
		const key = `${owner}/${repo}/${prNumber}`;
		const fixture = this.prFixtures.get(key);
		if (fixture === undefined) throw new Error(`No fixture for ${key}`);
		return fixture;
	}

	async listOpenPullRequests(owner: string, repo: string): Promise<ReadonlyArray<RawPRPayload>> {
		const prefix = `${owner}/${repo}/`;
		return [...this.prFixtures.entries()]
			.filter(([k]) => k.startsWith(prefix))
			.map(([, v]) => v);
	}

	async mergePullRequest(owner: string, repo: string, prNumber: number): Promise<void> {
		this.mergedPrs.push(`${owner}/${repo}/${prNumber}`);
	}

	async revertPullRequest(owner: string, repo: string, prNumber: number): Promise<string> {
		this.revertedPrs.push(`${owner}/${repo}/${prNumber}`);
		return `https://github.com/${owner}/${repo}/pull/999`;
	}
}
