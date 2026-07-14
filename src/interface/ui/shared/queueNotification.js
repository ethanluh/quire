// Small persistent notifications that track an accepted bundle's progress through
// the merge queue: queue position while it waits, merge progress once landing,
// then a terminal state (landed/conflict) — driven entirely off whatever `GET
// /queue` data the page already has via loadQueue(); no dedicated endpoint.

const QUEUE_NOTIFICATION_TTL_MS = 3500;
const trackedQueueNotifications = new Set();
const queueNotificationLandedTimers = new Map();
let lastQueueEntriesForNotifications = [];

// "Process all"'s own aggregate progress — not a real bundleId, so it's kept
// separate from trackedQueueNotifications and always rendered first (above
// the per-bundle cards) while active.
let processAllProgress = null;
let processAllDismissTimer = null;

function processAllNotificationCardHtml() {
  if (!processAllProgress) return '';
  const { processed, total, done, landed, conflicts } = processAllProgress;
  const fraction = total ? processed / total : 0;
  const tone = done ? (conflicts > 0 ? 'critical' : 'clean') : 'flagged';
  const label = done
    ? `Processed ${processed}: ${landed} landed, ${conflicts} conflict(s)`
    : `Processing ${processed}/${total}`;
  return `<div class="queue-notification queue-notification-${tone}">
    ${queueRingSvg(fraction, tone)}
    <div class="queue-notification-body">
      <div class="queue-notification-title">Process all</div>
      <div class="queue-notification-status">${label}</div>
    </div>
  </div>`;
}

// Call once per iteration of the "Process all" loop with the running counts.
function showProcessAllProgress(processed, total) {
  clearTimeout(processAllDismissTimer);
  processAllProgress = { processed, total, done: false };
  renderTrackedQueueNotifications();
}

// Call once the loop finishes — turns the ring solid (green unless any
// conflicts happened) and auto-dismisses after the same TTL a landed
// per-bundle card uses.
function finishProcessAllProgress(processed, total, landed, conflicts) {
  processAllProgress = { processed, total, done: true, landed, conflicts };
  renderTrackedQueueNotifications();
  clearTimeout(processAllDismissTimer);
  processAllDismissTimer = setTimeout(() => {
    processAllProgress = null;
    renderTrackedQueueNotifications();
  }, QUEUE_NOTIFICATION_TTL_MS);
}

function queueNotificationStackEl() {
  return document.getElementById('queue-notifications');
}

// Finds the member PR behind an "unstable" conflict (both "checks failing" and "checks
// still running" report as this GitHub mergeable_state — see render.js's
// unstableConflictBadge for the same distinction on the review-queue badge).
function unstableConflictMember(entry) {
  if (!entry || !entry.conflict || entry.conflict.kind !== 'unstable') return undefined;
  return ((entry.bundle && entry.bundle.members) || []).find((m) => m.id === entry.conflict.prId);
}

function queueNotificationTone(entry) {
  if (!entry) return 'neutral';
  if (entry.status === 'landing') return 'flagged';
  if (entry.status === 'landed') return 'clean';
  if (entry.status === 'conflict') {
    const member = unstableConflictMember(entry);
    if (member && member.ciStatus === 'pending') return 'flagged';
  }
  if (['conflict', 'aborted', 'investigating'].includes(entry.status)) return 'critical';
  return 'neutral'; // queued
}

function queueRingSvg(fraction, tone) {
  const r = 15;
  const circumference = 2 * Math.PI * r;
  const offset = circumference * (1 - Math.max(0, Math.min(1, fraction)));
  return `<svg class="queue-ring" viewBox="0 0 36 36" width="36" height="36" aria-hidden="true">
    <circle class="queue-ring-track" cx="18" cy="18" r="${r}"></circle>
    <circle class="queue-ring-fill tier-${tone}" cx="18" cy="18" r="${r}" stroke-dasharray="${circumference}" stroke-dashoffset="${offset}"></circle>
  </svg>`;
}

// Processing (FIFO) order — oldest enqueuedAt first — matching the order
// MergeQueue.dequeueNext() actually drains in. This is deliberately NOT the
// same order listEntries() returns for display (most-recently-enqueued first).
function activeQueueProcessingOrder(queueEntries) {
  return queueEntries
    .filter((e) => e.status === 'queued' || e.status === 'landing')
    .slice()
    .sort((a, b) => new Date(a.enqueuedAt) - new Date(b.enqueuedAt));
}

function queueNotificationCardHtml(bundleId, entry, order) {
  const tone = queueNotificationTone(entry);
  let direction = '';
  let label = 'Queued…';
  let fraction = 0;

  if (entry) {
    direction = escapeHtml(entry.bundle.direction);
    if (entry.status === 'landing') {
      const total = entry.bundle.members.length || 1;
      const done = entry.mergedPrIds.length;
      fraction = done / total;
      label = `Landing ${done}/${total}`;
    } else if (entry.status === 'landed') {
      fraction = 1;
      label = 'Landed';
    } else if (['conflict', 'aborted', 'investigating'].includes(entry.status)) {
      const member = unstableConflictMember(entry);
      if (member && member.ciStatus === 'pending') {
        const summary = member.ciChecksSummary;
        fraction = summary ? summary.completed / summary.total : 0;
        label = summary ? `Checks in progress (${summary.completed}/${summary.total})` : 'Checks in progress';
      } else {
        fraction = 1;
        // "Needs attention" told you nothing you didn't already know from the
        // critical-tier ring — name what actually happened instead.
        if (entry.status === 'conflict') {
          label = 'Merge conflict';
        } else if (entry.status === 'aborted') {
          const total = entry.bundle.members.length || 1;
          const remaining = total - entry.mergedPrIds.length;
          label = remaining ? `Aborted — ${remaining} remaining` : 'Aborted';
        } else {
          const investigations = entry.investigations || [];
          label = investigations.some((inv) => inv.status === 'awaitingReview')
            ? 'Investigation ready for review'
            : 'Investigation in progress';
        }
      }
    } else {
      const position = order.findIndex((e) => e.bundleId === bundleId);
      const total = order.length || 1;
      fraction = position < 0 ? 0 : (total - position) / total;
      label = position < 0 ? 'Queued' : position === 0 ? 'Next up' : `#${position + 1} in queue`;
    }
  }

  const detailBtn = tone === 'critical'
    ? `<button class="btn btn-show-queue-detail" data-bundle-id="${escapeHtml(bundleId)}">View</button>`
    : '';

  return `<div class="queue-notification queue-notification-${tone}" data-bundle-id="${escapeHtml(bundleId)}">
    ${queueRingSvg(fraction, tone)}
    <div class="queue-notification-body">
      ${direction ? `<div class="queue-notification-title">${direction}</div>` : ''}
      <div class="queue-notification-status">${label}</div>
    </div>
    ${detailBtn}
  </div>`;
}

function renderTrackedQueueNotifications() {
  const stack = queueNotificationStackEl();
  if (!stack) return;
  const entries = lastQueueEntriesForNotifications;
  const byId = new Map(entries.map((e) => [e.bundleId, e]));
  const order = activeQueueProcessingOrder(entries);
  // Most recently tracked on top; the "Process all" aggregate (if active)
  // always leads the stack.
  const ids = Array.from(trackedQueueNotifications).reverse();
  stack.innerHTML = processAllNotificationCardHtml() + ids.map((id) => queueNotificationCardHtml(id, byId.get(id), order)).join('');
}

// Call right after a bundle is successfully accepted, before the next
// loadQueue() response has necessarily come back — renders an initial
// "Queued…" placeholder immediately so the accept feels acknowledged.
function trackQueueNotification(bundleId) {
  trackedQueueNotifications.add(bundleId);
  renderTrackedQueueNotifications();
}

// Call once per loadQueue() refresh (SSE-triggered or polled) with the
// freshly fetched entries, so every tracked notification's ring/label stays
// current without any notification-specific fetch of its own.
function updateQueueNotifications(queueEntries) {
  lastQueueEntriesForNotifications = queueEntries;
  if (!trackedQueueNotifications.size) return;

  const byId = new Map(queueEntries.map((e) => [e.bundleId, e]));
  for (const bundleId of Array.from(trackedQueueNotifications)) {
    const entry = byId.get(bundleId);
    if (!entry) {
      // Missing means removed/reverted/closed externally — drop it, unless
      // it's a landed entry already counting down its own dismiss timer.
      if (!queueNotificationLandedTimers.has(bundleId)) {
        trackedQueueNotifications.delete(bundleId);
      }
      continue;
    }
    if (entry.status === 'landed' && !queueNotificationLandedTimers.has(bundleId)) {
      queueNotificationLandedTimers.set(bundleId, setTimeout(() => {
        trackedQueueNotifications.delete(bundleId);
        queueNotificationLandedTimers.delete(bundleId);
        renderTrackedQueueNotifications();
      }, QUEUE_NOTIFICATION_TTL_MS));
    }
  }

  renderTrackedQueueNotifications();
}
