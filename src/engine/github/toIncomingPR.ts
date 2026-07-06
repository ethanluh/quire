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
		...(pr.linkedIssueNumber !== undefined ? { linkedIssueNumber: pr.linkedIssueNumber } : {}),
		diff: { raw: pr.diff, hunks: parseUnifiedDiff(pr.diff) },
		filesTouched: [...pr.filesTouched],
		ciStatus: pr.ciStatus,
	};
}
