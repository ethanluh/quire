// Cache of the last-rendered JSON per pane so polling can skip a DOM rebuild
// when nothing actually changed (avoids flicker/lost hover state on idle ticks).
const lastRenderedJson = {};

// Optional hook a page can override before the first poll tick fires, to skip a
// review-pane refresh mid-interaction. Desktop's plain card list never needs this
// and leaves the default; mobile's swipeable stack overrides it to skip a refresh
// while a card is actively being dragged or is mid-commit-animation.
let canRefreshReviewPane = () => true;

// Server state is already kept fresh by the GitHub webhook + reconciliation poll
// (see routes/webhook.ts); these endpoints just read that in-memory state, so
// polling them here is cheap and never itself calls the GitHub API.
const POLL_INTERVAL_MS = 10000;
let pollTimer = null;

// The queue-notification stack (shared/queueNotification.js) is a persistent overlay that can
// be visible regardless of which pane is active, but its data only comes from a /queue fetch.
// Refresh it here, independent of loadQueue(), so it doesn't sit stale until the user switches
// to the Bundle Status tab.
async function refreshQueueNotificationsOnly() {
	const entries = await api('GET', '/queue');
	if (entries.error) return;
	updateQueueNotifications(entries);
}

function pollActivePane() {
	if (document.hidden) return;
	const activeTab = document.querySelector('.tab.active');
	if (!activeTab) return;
	const pane = activeTab.dataset.tab;
	if (pane === 'review') {
		if (canRefreshReviewPane()) loadReview();
	} else if (pane === 'shelf') {
		loadShelf();
	} else if (pane === 'queue') {
		loadQueue();
	} else if (pane === 'audit') {
		loadAudit();
	}
	if (pane !== 'queue' && hasTrackedQueueNotifications()) {
		refreshQueueNotificationsOnly();
	}
}

function startPolling() {
	if (pollTimer) return;
	pollTimer = setInterval(pollActivePane, POLL_INTERVAL_MS);
}

// Independent of the cheap poll above and the SSE push below — this is the fallback for when
// neither a webhook nor the reconciliation timer has run yet (a missed/misconfigured webhook
// delivery, or a stretch with no push connection). Calls the real refresh endpoint on a slow
// cadence so new/closed PRs surface within about a minute even with no push at all, instead of
// waiting on the server's own (much longer) reconciliation interval.
const BACKGROUND_REFRESH_INTERVAL_MS = 60000;
let backgroundRefreshTimer = null;

function backgroundRefresh() {
	if (document.hidden) return;
	if (!canRefreshReviewPane()) return;
	refreshAndLoadReview();
}

function startBackgroundRefresh() {
	if (backgroundRefreshTimer) return;
	backgroundRefreshTimer = setInterval(backgroundRefresh, BACKGROUND_REFRESH_INTERVAL_MS);
}

// Push path: the server emits a "refresh" event on /events (see routes/events.ts) the moment
// a webhook or reconciliation pass changes state, so the active pane updates immediately
// instead of waiting for the next poll tick. The interval above stays
// running regardless — it's the fallback for a dropped/unsupported EventSource, same as the
// server's own reconciliation timer is a fallback for a missed webhook delivery.
document.addEventListener('visibilitychange', () => {
	if (!document.hidden) pollActivePane();
});

// Pulls the selected repo's current PRs from GitHub before rendering, so a fresh page
// load/reload reflects reality instead of whatever's been cached in server memory since
// the last webhook or reconcile tick. Best-effort: a failed refresh still falls back to
// rendering whatever's already there.
async function refreshAndLoadReview() {
	try {
		await api('POST', '/account/github/repos/refresh', undefined);
	} catch (err) {
		console.error('PR refresh failed', err);
	}
	loadReview();
}

// Team switch/create/leave changes which tenant's data is active — every pane and settings
// panel needs to re-fetch, but (unlike sign-out) the user is still mid-session, so do it in
// place instead of location.reload()ing and blowing away "Settings is open" / which settings
// section is active / an open modal in general (the header team switcher is reachable while
// Settings is open too).
async function refreshAfterTeamChange() {
	delete lastRenderedJson.review;
	delete lastRenderedJson.shelf;
	delete lastRenderedJson.queue;
	await refreshAndLoadReview();
	await loadShelf();
	await loadQueue();
	await loadAudit();
	await loadAccount();
	await loadLlmAccount();
	await loadTeam();
}
