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

function ciStatusBadge(status) {
  const cls = status === 'success' ? 'badge-clean' : status === 'failure' ? 'badge-flagged' : 'badge-neutral';
  return `<span class="badge ${cls}">CI: ${escapeHtml(status)}</span>`;
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
    <button class="btn btn-reject" onclick="disconnectInstallation(${installation.installationId})">Disconnect</button>
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
    <select onchange="setMemberRole('${escapeHtml(m.login)}', this.value)">${roleOptions}</select>
    <button class="btn btn-reject" onclick="removeMember('${escapeHtml(m.login)}')">Remove</button>
  </div>`;
}

function prDriftBadges(prId, drift) {
  if (!drift || drift.status !== 'flagged') return '';
  const signals = drift.signals.filter(s => s.prId === prId);
  const footprintCount = signals.filter(s => s.kind === 'footprintAnomaly').length;
  const behavioralCount = signals.filter(s => s.kind === 'behavioralDelta').length;
  const effectCount = signals.filter(s => s.kind === 'effectList').length;
  const badges = [];
  // footprintAnomaly/behavioralDelta are grounded in static analysis or confirmed
  // behavior, not an LLM judgment call — treated as the more severe tier (red).
  // effectList is the matcher's best-effort read on declared vs. actual effects,
  // more prone to false positives — the existing "flagged" tier (amber).
  if (footprintCount > 0) badges.push(`<span class="badge badge-critical">Footprint: ${footprintCount}</span>`);
  if (behavioralCount > 0) badges.push(`<span class="badge badge-critical">Behavioral: ${behavioralCount}</span>`);
  if (effectCount > 0) badges.push(`<span class="badge badge-flagged">Effects: ${effectCount}</span>`);
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
        ${ciStatusBadge(pr.ciStatus)}
        <span class="badge badge-neutral">${pr.filesTouched.length} files</span>
      </div>
    </div>`;
  }).join('') + '</div>';
}

function prMergeStatusBadge(pr, mergeStatus) {
  if (!mergeStatus) return '';
  if (mergeStatus.revertedPrIds.includes(pr.id)) return `<span class="badge badge-${PR_MERGE_STATUS_TIER.reverted}">Merge: reverted</span>`;
  if (mergeStatus.mergedPrIds.includes(pr.id)) return `<span class="badge badge-${PR_MERGE_STATUS_TIER.merged}">Merge: merged</span>`;
  if (mergeStatus.conflict && mergeStatus.conflict.prId === pr.id) {
    const { cls, label } = CONFLICT_KIND_BADGE[mergeStatus.conflict.kind] || CONFLICT_KIND_BADGE.mergeConflict;
    return `<span class="badge ${cls}">${escapeHtml(label)}</span>`;
  }
  return `<span class="badge badge-${PR_MERGE_STATUS_TIER.pending}">Merge: pending</span>`;
}

function queueStatusBadge(e) {
  if (e.status === 'conflict' && e.conflict && e.conflict.kind) {
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

function renderSignals(drift, members) {
  if (drift.status !== 'flagged') return '';
  const items = drift.signals.map(s => {
    const pr = members && members.find(m => m.id === s.prId);
    const prefix = pr ? `[${escapeHtml(pr.repoOwner)}/${escapeHtml(pr.repoName)}#${pr.number}] ` : '';
    if (s.kind === 'effectList') return `${prefix}Orphan effects: ${escapeHtml(s.orphanClauses.join(', '))}`;
    if (s.kind === 'footprintAnomaly') return `${prefix}Surprising symbols: ${escapeHtml(s.surprisingSymbols.map(x => x.name).join(', '))}`;
    return `${prefix}${escapeHtml(s.description)}`;
  });
  return `<div class="drift-signals"><strong>Drift signals (noted, not an error)</strong><ul>${items.map(i => `<li>${i}</li>`).join('')}</ul></div>`;
}

function renderWatchedRepos(repos) {
  const el = document.getElementById('watched-repos-list');
  el.innerHTML = repos.length
    ? repos.map(watchedRepoRowHtml).join('')
    : '<div class="empty">No repos selected yet — pick one below.</div>';
}

function showTeamResult(message, isError) {
  const resultEl = document.getElementById('team-result');
  resultEl.textContent = message;
  resultEl.className = isError ? 'result-msg error' : 'result-msg';
  resultEl.style.display = 'block';
}

function watchedRepoRowHtml(repo) {
  const settingsDisabled = isOwner() ? '' : 'disabled';
  const removeDisabled = canManageMembers() ? '' : 'disabled';
  return `<div class="watched-repo-row" data-owner="${escapeHtml(repo.owner)}" data-name="${escapeHtml(repo.name)}">
    <div class="watched-repo-header">
      <span class="repo-name">${escapeHtml(repo.owner)}/${escapeHtml(repo.name)}</span>
      <button class="btn btn-reject btn-remove-repo" ${removeDisabled}>Remove</button>
    </div>
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
