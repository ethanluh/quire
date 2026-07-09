import type { JudgeActionState } from "../types/judge.js";
import { createJsonStatePersistence } from "../util/jsonStatePersistence.js";

const EMPTY_STATE: JudgeActionState = { entries: [] };

function isJudgeActionState(value: unknown): value is JudgeActionState {
	return typeof value === "object" && value !== null && "entries" in value && Array.isArray((value as Record<string, unknown>)["entries"]);
}

export const { loadState, saveState } = createJsonStatePersistence<JudgeActionState>(isJudgeActionState, EMPTY_STATE);
