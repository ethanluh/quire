import type { IncomingPR } from "../ingest/schema.js";
import type { RawPRPayload } from "./client.js";
import { parseUnifiedDiff } from "./diffParser.js";

export function rawPRPayloadToIncomingPR(pr: RawPRPayload): IncomingPR {
	return {
		id: pr.id,
		repoOwner: pr.owner,
		repoName: pr.repo,
		number: pr.number,
		headSha: pr.headSha,
		declaredDirection: pr.declaredDirection,
		directionInferred: pr.directionInferred,
		...(pr.linkedIssueNumber !== undefined ? { linkedIssueNumber: pr.linkedIssueNumber } : {}),
		diff: { raw: pr.diff, hunks: parseUnifiedDiff(pr.diff) },
		filesTouched: [...pr.filesTouched],
		labels: [...pr.labels],
		assignees: [...pr.assignees],
		ciStatus: pr.ciStatus,
		...(pr.ciChecksSummary !== undefined ? { ciChecksSummary: pr.ciChecksSummary } : {}),
	};
}
