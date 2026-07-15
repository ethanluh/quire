const CONFLICT_KIND_BADGE = {
  mergeConflict: { cls: 'badge-critical', label: 'Conflict' },
  blocked: { cls: 'badge-flagged', label: 'Blocked' },
  unstable: { cls: 'badge-flagged', label: 'Checks failing' },
  timedOut: { cls: 'badge-neutral', label: 'Pending GitHub' },
  unresolvable: { cls: 'badge-flagged', label: "Can't merge" },
};

const PR_MERGE_STATUS_TIER = { pending: 'neutral', merged: 'clean', reverted: 'critical' };

const CONFLICT_KIND_COPY = {
  mergeConflict: { headline: 'Merge conflict detected', guidance: "Automated resolution did not apply — see the conflicting PR's GitHub link below for details, or retry." },
  blocked: { headline: 'Blocked, not a merge conflict', guidance: 'Resolve the required review or branch-protection rule on GitHub, then retry.' },
  unstable: { headline: 'Checks failing or pending, not a merge conflict', guidance: 'Wait for CI or fix the failing check, then retry.' },
  timedOut: { headline: 'Mergeability still unknown', guidance: "GitHub hasn't finished computing this yet — this usually clears on its own; retry in a moment." },
  unresolvable: { headline: "Can't merge", guidance: 'See the PR on GitHub for details, or retry.' },
};

const QUEUE_STATUS_TIER = { queued: 'neutral', landing: 'flagged', landed: 'clean', closed: 'neutral', conflict: 'critical', aborted: 'critical', investigating: 'flagged', reverted: 'critical' };

function ciStatusBadge(status, checksSummary) {
  const cls = status === 'success' ? 'badge-clean' : status === 'failure' ? 'badge-flagged' : 'badge-neutral';
  const counts = status === 'pending' && checksSummary ? ` (${checksSummary.completed}/${checksSummary.total})` : '';
  return `<span class="badge ${cls}">CI: ${escapeHtml(status)}${counts}</span>`;
}

// GitHub's mergeable_state reports "unstable" for both "required checks are failing" and
// "required checks are still running" — it can't tell the two apart. Quire's own ciStatus
// (from the real Checks API) can, so use it to pick the accurate badge instead of always
// showing "Checks failing" while CI is still in flight.
function unstableConflictBadge(ciStatus, ciChecksSummary) {
  if (ciStatus === 'pending') {
    const counts = ciChecksSummary ? ` (${ciChecksSummary.completed}/${ciChecksSummary.total})` : '';
    return { cls: 'badge-neutral', label: `Checks in progress${counts}` };
  }
  return CONFLICT_KIND_BADGE.unstable;
}

function conflictResidualHtml(conflict) {
  const { headline, guidance } = CONFLICT_KIND_COPY[conflict.kind] || CONFLICT_KIND_COPY.mergeConflict;
  return `<div class="residual">${escapeHtml(headline)} ${escapeHtml(conflict.detectedAt)} — ${escapeHtml(conflict.reason)}. ${escapeHtml(guidance)}</div>`;
}

function directionInferredBadge(inferred) {
  return inferred
    ? `<span class="badge badge-neutral" title="No declared-direction marker was found on this PR; the direction shown was inferred from its title/description, not explicitly declared.">Inferred</span>`
    : '';
}

function driftBadge(drift) {
  if (drift.status === 'clean') return '<span class="badge badge-clean">Clean</span>';
  return '<span class="badge badge-flagged">Drift flagged</span>';
}

function installationHtml(installation) {
  return `<div class="repo-entry">
    <span class="badge badge-neutral">${escapeHtml(installation.accountType)}</span>
    <span class="repo-name">${escapeHtml(installation.accountLogin)}</span>
    <button class="btn btn-reject btn-disconnect-installation" data-installation-id="${escapeHtml(String(installation.installationId))}">Disconnect</button>
  </div>`;
}

function investigationsHtml(bundleId, investigations) {
  if (!investigations || !investigations.length) return '';
  return investigations.map((inv) => {
    if (inv.status === 'running') {
      return `<div class="residual">Deep investigation in progress for <code>${escapeHtml(inv.path)}</code>&hellip;</div>`;
    }
    if (inv.status === 'failed') {
      return `<div class="residual">Deep investigation for <code>${escapeHtml(inv.path)}</code> did not produce a usable result: ${escapeHtml(inv.failureReason || 'unknown error')}</div>`;
    }
    if (inv.status !== 'awaitingReview' || !inv.decisionPacket) {
      return `<div class="residual">Investigation for <code>${escapeHtml(inv.path)}</code>: ${escapeHtml(inv.status)}</div>`;
    }
    const p = inv.decisionPacket;
    return `<div class="decision-packet">
      <h4>Deep investigation result: ${escapeHtml(inv.path)}</h4>
      <p>${escapeHtml(p.rationale)}</p>
      <p><strong>Confidence:</strong> ${escapeHtml(p.confidence)} &middot; <strong>Tests:</strong> ${escapeHtml(p.testResult)}</p>
      ${(p.evidence || []).length ? `<ul>${p.evidence.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : ''}
      ${(p.testsRun || []).length ? `<p><strong>Ran:</strong> ${p.testsRun.map(escapeHtml).join(', ')}</p>` : ''}
      ${p.openQuestion ? `<p class="residual">Open question: ${escapeHtml(p.openQuestion)}</p>` : ''}
      <div class="gestures">
        <button class="btn btn-accept btn-investigation-accept" data-bundle-id="${escapeHtml(bundleId)}" data-path="${escapeHtml(inv.path)}">Accept</button>
        <button class="btn btn-reject btn-investigation-reject" data-bundle-id="${escapeHtml(bundleId)}" data-path="${escapeHtml(inv.path)}">Reject</button>
      </div>
    </div>`;
  }).join('');
}

function memberRowHtml(m) {
  const badge = `<span class="badge badge-neutral">${escapeHtml(m.role)}</span>`;
  if (!canManageMembers() || (m.role === 'owner' && !isOwner())) {
    return `<div class="repo-entry"><span class="repo-name">${escapeHtml(m.login)}</span>${badge}</div>`;
  }
  const roleOptions = ['owner', 'admin', 'member']
    .filter((r) => r !== 'owner' || isOwner())
    .map((r) => `<option value="${r}" ${r === m.role ? 'selected' : ''}>${r}</option>`)
    .join('');
  return `<div class="repo-entry">
    <span class="repo-name">${escapeHtml(m.login)}</span>
    ${badge}
    <select class="select-member-role" data-login="${escapeHtml(m.login)}">${roleOptions}</select>
    <button class="btn btn-reject btn-remove-member" data-login="${escapeHtml(m.login)}">Remove</button>
  </div>`;
}

function prDriftBadges(prId, drift) {
  if (!drift || drift.status !== 'flagged') return '';
  const signals = drift.signals.filter(s => s.prId === prId);
  const footprintCount = signals.filter(s => s.kind === 'footprintAnomaly').length;
  const behavioralCount = signals.filter(s => s.kind === 'behavioralDelta').length;
  const effectCount = signals.filter(s => s.kind === 'effectList').length;
  const inconsistencyCount = signals.filter(s => s.kind === 'symbolInconsistency').length;
  const badges = [];
  // footprintAnomaly/behavioralDelta are grounded in static analysis or confirmed
  // behavior, not an LLM judgment call — treated as the more severe tier (red).
  // effectList is the matcher's best-effort read on declared vs. actual effects,
  // more prone to false positives — the existing "flagged" tier (amber).
  if (footprintCount > 0) badges.push(`<span class="badge badge-critical">Footprint: ${footprintCount}</span>`);
  if (behavioralCount > 0) badges.push(`<span class="badge badge-critical">Behavioral: ${behavioralCount}</span>`);
  if (effectCount > 0) badges.push(`<span class="badge badge-flagged">Effects: ${effectCount}</span>`);
  // symbolInconsistency is a heuristic name-based match (no rename/scope resolution in v1) —
  // lower-confidence than footprintAnomaly's file-set check, so it sits in the amber tier
  // alongside effectList rather than the red tier.
  if (inconsistencyCount > 0) badges.push(`<span class="badge badge-flagged">Symbol conflict: ${inconsistencyCount}</span>`);
  return badges.join('');
}

function prMemberListHtml(members, drift, mergeStatus) {
  if (!members.length) return '<div class="empty">No member PRs.</div>';
  return '<div class="pr-member-list">' + members.map(pr => {
    const url = `https://github.com/${pr.repoOwner}/${pr.repoName}/pull/${pr.number}`;
    return `<div class="pr-member-row">
      <div class="pr-member-info">
        <a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(pr.repoOwner)}/${escapeHtml(pr.repoName)}#${pr.number}</a>
        <span class="pr-member-direction">${escapeHtml(pr.declaredDirection)} ${directionInferredBadge(pr.directionInferred)}</span>
      </div>
      <div class="pr-member-tags">
        ${prMergeStatusBadge(pr, mergeStatus)}
        ${prDriftBadges(pr.id, drift)}
        ${ciStatusBadge(pr.ciStatus, pr.ciChecksSummary)}
        <span class="badge badge-neutral">${pr.filesTouched.length} files</span>
        ${pr.labels.map(l => `<span class="badge badge-neutral">${escapeHtml(l)}</span>`).join('')}
        ${pr.assignees.length ? `<span class="badge badge-neutral">${pr.assignees.map(escapeHtml).join(', ')}</span>` : ''}
      </div>
    </div>`;
  }).join('') + '</div>';
}

function prMergeStatusBadge(pr, mergeStatus) {
  if (!mergeStatus) return '';
  if (mergeStatus.revertedPrIds.includes(pr.id)) return `<span class="badge badge-${PR_MERGE_STATUS_TIER.reverted}">Merge: reverted</span>`;
  if (mergeStatus.mergedPrIds.includes(pr.id)) return `<span class="badge badge-${PR_MERGE_STATUS_TIER.merged}">Merge: merged</span>`;
  if (mergeStatus.conflict && mergeStatus.conflict.prId === pr.id) {
    const { cls, label } = mergeStatus.conflict.kind === 'unstable'
      ? unstableConflictBadge(pr.ciStatus, pr.ciChecksSummary)
      : (CONFLICT_KIND_BADGE[mergeStatus.conflict.kind] || CONFLICT_KIND_BADGE.mergeConflict);
    return `<span class="badge ${cls}">${escapeHtml(label)}</span>`;
  }
  return `<span class="badge badge-${PR_MERGE_STATUS_TIER.pending}">Merge: pending</span>`;
}

const INVESTIGATION_STATUS_TIER = { running: 'neutral', awaitingReview: 'flagged', failed: 'critical', accepted: 'clean', rejected: 'critical' };
const INVESTIGATION_STATUS_LABEL = { running: 'running', awaitingReview: 'awaiting review', failed: 'failed', accepted: 'accepted', rejected: 'rejected' };
const INVESTIGATION_STATUS_DOT_CLASS = { running: 'running', awaitingReview: 'awaiting', failed: 'failed', accepted: 'accepted', rejected: 'rejected' };

// Merge progress across the bundle's member PRs — "M/N merged" plus a fill bar, except
// for the two terminal statuses where a bar reads as still-in-motion when it isn't:
// aborted (the rest simply stopped retrying, nothing keeps landing) and reverted (the
// bar's "fullness" metaphor doesn't fit a count that went backwards).
function queueProgressHtml(e) {
  const total = e.bundle.members.length;
  const merged = e.mergedPrIds.length;
  if (e.status === 'aborted') {
    const remaining = total - merged;
    return `<span class="progress-label">${merged}/${total} merged${remaining ? ` &middot; ${remaining} remaining aborted` : ''}</span>`;
  }
  if (e.status === 'reverted') {
    const reverted = e.revertedPrIds.length;
    return `<span class="progress-label">${merged}/${total} merged${reverted ? ` &middot; ${reverted} reverted` : ''}</span>`;
  }
  const pct = total ? Math.round((merged / total) * 100) : 0;
  const critical = e.status === 'conflict';
  return `<span class="progress-label">${merged}/${total} merged</span><span class="progress-track"><span class="progress-fill${critical ? ' critical' : ''}" style="width:${pct}%"></span></span>`;
}

// Compact one-line conflict reason for the collapsed card — headline + when, not the
// full reason/guidance text (that stays in conflictResidualHtml() inside the modal).
function queueConflictReasonHtml(conflict) {
  if (!conflict) return '';
  const { headline } = CONFLICT_KIND_COPY[conflict.kind] || CONFLICT_KIND_COPY.mergeConflict;
  return `<span class="status-reason">${escapeHtml(headline)} ${escapeHtml(conflict.detectedAt)}</span>`;
}

// Tally of in-flight deep investigations by status, for the collapsed card — the full
// per-file detail (rationale, evidence, accept/reject) stays in investigationsHtml().
function investigationSummaryHtml(investigations) {
  if (!investigations || !investigations.length) return '';
  const counts = {};
  investigations.forEach((inv) => { counts[inv.status] = (counts[inv.status] || 0) + 1; });
  const items = Object.keys(INVESTIGATION_STATUS_LABEL)
    .filter((status) => counts[status])
    .map((status) => `<span class="dot ${INVESTIGATION_STATUS_DOT_CLASS[status]}">${counts[status]} ${INVESTIGATION_STATUS_LABEL[status]}</span>`);
  return `<span class="inv-tally">${items.join('')}</span>`;
}

// The card's secondary status row — whatever's relevant to this bundle's current
// status, per the reviewed mockup: investigation tally while investigating, otherwise
// merge progress plus a conflict reason when there is one.
function queueStatusRowHtml(e) {
  if (e.status === 'investigating') return investigationSummaryHtml(e.investigations);
  return queueProgressHtml(e) + (e.status === 'conflict' ? queueConflictReasonHtml(e.conflict) : '');
}

function queueStatusBadge(e) {
  if (e.status === 'conflict' && e.conflict && e.conflict.kind) {
    if (e.conflict.kind === 'unstable') {
      const member = e.bundle && e.bundle.members && e.bundle.members.find(m => m.id === e.conflict.prId);
      const { cls, label } = member ? unstableConflictBadge(member.ciStatus, member.ciChecksSummary) : CONFLICT_KIND_BADGE.unstable;
      return `<span class="badge ${cls}">${escapeHtml(label)}</span>`;
    }
    const { cls, label } = CONFLICT_KIND_BADGE[e.conflict.kind] || CONFLICT_KIND_BADGE.mergeConflict;
    return `<span class="badge ${cls}">${escapeHtml(label)}</span>`;
  }
  const tier = QUEUE_STATUS_TIER[e.status] || 'neutral';
  return `<span class="badge badge-${tier}">${escapeHtml(e.status)}</span>`;
}

function renderHeaderRepo(selectedRepo) {
  const badge = document.getElementById('header-repo-badge');
  if (!selectedRepo) {
    badge.style.display = 'none';
    return;
  }
  badge.textContent = `${selectedRepo.owner}/${selectedRepo.name}`;
  badge.style.display = 'inline-flex';
}

function renderHeaderTeam(activeName, teams) {
  const badge = document.getElementById('header-team-badge');
  const switcher = document.getElementById('header-team-switcher');
  if (teams.length > 1) {
    switcher.innerHTML = teams
      .map((t) => `<option value="${escapeHtml(t.teamId)}" ${t.active ? 'selected' : ''}>${escapeHtml(t.name)}</option>`)
      .join('');
    switcher.style.display = 'inline-block';
    badge.style.display = 'none';
  } else {
    badge.textContent = activeName;
    badge.style.display = 'inline-flex';
    switcher.style.display = 'none';
  }
}

function dedupeSymbolInconsistencySignals(signals) {
  // findSymbolInconsistencies emits one signal per implicated PR (so each PR's own badge,
  // via prDriftBadges above, reflects the conflict) — but that means the same bundle-wide
  // conflict appears once per implicated PR in this flat list. Collapse to one line per
  // distinct conflict for this list view only; per-PR badge counts are unaffected since
  // they read the un-deduped `drift.signals` directly.
  const seen = new Set();
  return signals.filter(s => {
    if (s.kind !== 'symbolInconsistency') return true;
    const key = s.symbol.name + ':' + s.touchedBy.map(t => t.prId + ':' + t.operation).sort().join(',');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function renderSignals(drift, members) {
  if (drift.status !== 'flagged') return '';
  const items = dedupeSymbolInconsistencySignals(drift.signals).map(s => {
    const pr = members && members.find(m => m.id === s.prId);
    const prefix = pr ? `[${escapeHtml(pr.repoOwner)}/${escapeHtml(pr.repoName)}#${pr.number}] ` : '';
    if (s.kind === 'effectList') return `${prefix}Orphan effects: ${escapeHtml(s.orphanClauses.join(', '))}`;
    if (s.kind === 'footprintAnomaly') return `${prefix}Surprising symbols: ${escapeHtml(s.surprisingSymbols.map(x => x.name).join(', '))}`;
    if (s.kind === 'symbolInconsistency') return `${prefix}Symbol conflict: ${escapeHtml(s.description)}`;
    return `${prefix}${escapeHtml(s.description)}`;
  });
  return `<div class="drift-signals"><strong>Drift signals (noted, not an error)</strong><ul>${items.map(i => `<li>${i}</li>`).join('')}</ul></div>`;
}

function renderWatchedRepos(repos, revokedInstallationIds) {
  const el = document.getElementById('watched-repos-list');
  el.innerHTML = repos.length
    ? repos.map((r) => watchedRepoRowHtml(r, revokedInstallationIds)).join('')
    : '<div class="empty">No repos selected yet — pick one below.</div>';
}

function showTeamResult(message, isError) {
  const resultEl = document.getElementById('team-result');
  resultEl.textContent = message;
  resultEl.className = isError ? 'result-msg error' : 'result-msg';
  resultEl.style.display = 'block';
}

function watchedRepoRowHtml(repo, revokedInstallationIds) {
  const settingsDisabled = isOwner() ? '' : 'disabled';
  const removeDisabled = canManageMembers() ? '' : 'disabled';
  const isRevoked = Boolean(revokedInstallationIds && revokedInstallationIds.has(repo.installationId));
  return `<div class="watched-repo-row" data-owner="${escapeHtml(repo.owner)}" data-name="${escapeHtml(repo.name)}">
    <div class="watched-repo-header">
      <span class="repo-name">${escapeHtml(repo.owner)}/${escapeHtml(repo.name)}</span>
      <button class="btn btn-reject btn-remove-repo" ${removeDisabled}>Remove</button>
    </div>
    ${isRevoked ? '<div class="result-msg error">⚠ GitHub App installation removed — this repo has stopped refreshing. Remove it below or reinstall the app.</div>' : ''}
    <label class="auto-merge-toggle">
      <input type="checkbox" class="chk-repo-setting" data-setting="autoMergeOnAccept" ${repo.autoMergeOnAccept ? 'checked' : ''} ${settingsDisabled}>
      Automatically merge accepted bundles (skips the manual "Process next" step)
    </label>
    <label class="auto-merge-toggle">
      <input type="checkbox" class="chk-repo-setting" data-setting="flagConflictsForFleet" ${repo.flagConflictsForFleet ? 'checked' : ''} ${settingsDisabled}>
      Flag unresolved merge conflicts back to my agent fleet (posts a PR comment)
    </label>
    <label class="auto-merge-toggle">
      <input type="checkbox" class="chk-repo-setting" data-setting="enableDeepConflictInvestigation" ${repo.enableDeepConflictInvestigation ? 'checked' : ''} ${settingsDisabled}>
      Escalate unresolved merge conflicts to a Quire-hosted deep investigation (requires an Anthropic API key connected below)
    </label>
  </div>`;
}
