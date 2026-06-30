export class StubGitHubClient {
    prFixtures = new Map();
    mergedPrs = [];
    revertedPrs = [];
    addFixture(owner, repo, pr) {
        this.prFixtures.set(`${owner}/${repo}/${pr.number}`, pr);
    }
    async getPullRequest(owner, repo, prNumber) {
        const key = `${owner}/${repo}/${prNumber}`;
        const fixture = this.prFixtures.get(key);
        if (fixture === undefined)
            throw new Error(`No fixture for ${key}`);
        return fixture;
    }
    async listOpenPullRequests(owner, repo) {
        const prefix = `${owner}/${repo}/`;
        return [...this.prFixtures.entries()]
            .filter(([k]) => k.startsWith(prefix))
            .map(([, v]) => v);
    }
    async mergePullRequest(owner, repo, prNumber) {
        this.mergedPrs.push(`${owner}/${repo}/${prNumber}`);
    }
    async revertPullRequest(owner, repo, prNumber) {
        this.revertedPrs.push(`${owner}/${repo}/${prNumber}`);
        return `https://github.com/${owner}/${repo}/pull/999`;
    }
}
