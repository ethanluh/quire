export interface SlackLink {
	label: string;
	url: string;
}

export interface SlackOutcomeMessage {
	kind: "auto-merged-and-verified" | "auto-rejected" | "reverted";
	bundleId: string;
	directionSummary: string;
	rationale: string;
	links: ReadonlyArray<SlackLink>;
}

export interface SlackEscalationMessage {
	bundleId: string;
	directionSummary: string;
	reason: string;
	rationale?: string;
	links: ReadonlyArray<SlackLink>;
}

// Two event kinds per the mission spec: terminal outcomes (auto-merged+verified,
// auto-rejected, reverted) and human escalations (anything the gate or verification
// disallowed/couldn't resolve). Kept as an interface — like LlmProvider — so it's
// swappable/testable without a real webhook, and so a future bot-token-based
// implementation can sit behind the exact same call sites.
export interface SlackNotifier {
	notifyOutcome(message: SlackOutcomeMessage): Promise<void>;
	notifyEscalation(message: SlackEscalationMessage): Promise<void>;
}

function formatLinks(links: ReadonlyArray<SlackLink>): string {
	return links.length > 0 ? links.map((l) => `<${l.url}|${l.label}>`).join(" · ") : "";
}

const OUTCOME_HEADLINE: Record<SlackOutcomeMessage["kind"], string> = {
	"auto-merged-and-verified": ":white_check_mark: Bundle Judge auto-merged and verified",
	"auto-rejected": ":x: Bundle Judge auto-rejected",
	reverted: ":leftwards_arrow_with_hook: Bundle Judge reverted after failed verification",
};

function formatOutcomeText(message: SlackOutcomeMessage): string {
	const lines = [
		`${OUTCOME_HEADLINE[message.kind]} — *${message.bundleId}*`,
		`Direction: ${message.directionSummary}`,
		`Rationale: ${message.rationale}`,
	];
	const links = formatLinks(message.links);
	if (links.length > 0) lines.push(links);
	return lines.join("\n");
}

function formatEscalationText(message: SlackEscalationMessage): string {
	const lines = [
		`:rotating_light: Bundle Judge escalating — *${message.bundleId}* needs a human`,
		`Direction: ${message.directionSummary}`,
		`Reason: ${message.reason}`,
		...(message.rationale !== undefined ? [`Rationale: ${message.rationale}`] : []),
	];
	const links = formatLinks(message.links);
	if (links.length > 0) lines.push(links);
	return lines.join("\n");
}

// Best-effort, fire-once, no retry — a failed Slack post must never affect the judge's own
// state machine (the action/verdict stores are the source of truth; Slack is a courtesy
// notification layered on top). A short timeout keeps a Slack outage from ever hanging the
// caller.
async function postToWebhook(webhookUrl: string, text: string): Promise<void> {
	const res = await fetch(webhookUrl, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ text }),
		signal: AbortSignal.timeout(10_000),
	});
	if (!res.ok) {
		throw new Error(`Slack webhook responded ${res.status}: ${await res.text()}`);
	}
}

export class WebhookSlackNotifier implements SlackNotifier {
	constructor(private readonly webhookUrl: string) {}

	async notifyOutcome(message: SlackOutcomeMessage): Promise<void> {
		try {
			await postToWebhook(this.webhookUrl, formatOutcomeText(message));
		} catch (err) {
			console.error(`Slack outcome notification failed for bundle ${message.bundleId} (ignored):`, err);
		}
	}

	async notifyEscalation(message: SlackEscalationMessage): Promise<void> {
		try {
			await postToWebhook(this.webhookUrl, formatEscalationText(message));
		} catch (err) {
			console.error(`Slack escalation notification failed for bundle ${message.bundleId} (ignored):`, err);
		}
	}
}

// No-op when QUIRE_SLACK_WEBHOOK_URL is unset — logs to the console instead so the outcome
// isn't entirely silent locally, but never throws and never requires the env var to exist.
// Mirrors resolveLlmProvider's/resolveJudgeProvider's "unconfigured degrades cleanly, never
// crashes" contract.
export class NoopSlackNotifier implements SlackNotifier {
	async notifyOutcome(message: SlackOutcomeMessage): Promise<void> {
		console.log(`[slack disabled] ${formatOutcomeText(message)}`);
	}

	async notifyEscalation(message: SlackEscalationMessage): Promise<void> {
		console.log(`[slack disabled] ${formatEscalationText(message)}`);
	}
}

export function resolveSlackNotifier(webhookUrl: string | undefined): SlackNotifier {
	return webhookUrl !== undefined && webhookUrl !== "" ? new WebhookSlackNotifier(webhookUrl) : new NoopSlackNotifier();
}
