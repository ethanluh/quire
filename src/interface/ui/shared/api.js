async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(path, opts);
  if (r.status === 401) {
    showSigninGate();
    return { error: 'Sign in required' };
  }
  return r.json();
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showToast(message, tone) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = `toast-${tone || 'error'} visible`;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.remove('visible'), 3500);
}

function showError(message) {
  showToast(message, 'error');
}

async function withPending(btn, pendingLabel, fn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = pendingLabel;
  try {
    return await fn();
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

async function checkSignedIn() {
  const res = await fetch('/account/github/session');
  if (res.status === 401) {
    showSigninGate();
    return false;
  }
  const { login } = await res.json();
  hideSigninGate(login);
  return true;
}

async function startOAuth(btn, errorEl) {
  btn.disabled = true;
  const result = await fetch('/account/github/oauth/start').then((r) => r.json());
  if (result.error) {
    errorEl.textContent = 'Error: ' + result.error;
    errorEl.className = 'result-msg error';
    errorEl.style.display = 'block';
    btn.disabled = false;
    return;
  }
  location.href = result.authorizeUrl;
}

function startLiveUpdates() {
  const source = new EventSource('/events');
  source.onmessage = () => pollActivePane();
}

async function abortQueueEntry(bundleId, mergedCount, totalCount) {
  const message = mergedCount > 0
    ? `Abort this bundle? ${mergedCount} of ${totalCount} member PRs already merged and will stay merged — aborting only stops Quire from retrying the rest. Nothing is reverted.`
    : 'Abort this bundle? It will stop being retried and remain in the queue marked as aborted.';
  if (!(await confirmAction(message))) return;
  await api('POST', `/queue/${bundleId}/abort`, undefined);
  loadQueue();
}

async function disconnectInstallation(installationId) {
  if (!(await confirmAction('Disconnect this GitHub App installation?'))) return;
  await api('POST', `/account/github/disconnect/${installationId}`, undefined);
  loadAccount();
}

async function overturnAudit(entryId) {
  await api('POST', `/audit/${entryId}/overturn`);
  loadAudit();
}

async function promote(bundleId) {
  await api('DELETE', `/shelf/${bundleId}`);
  loadShelf();
  loadReview();
}

async function reattemptQueueEntry(bundleId) {
  await api('POST', `/queue/${bundleId}/retry`, undefined);
  loadQueue();
}

async function removeMember(login) {
  if (!(await confirmAction(`Remove ${login} from this team?`))) return;
  const result = await api('POST', `/account/team/members/${login}/remove`, undefined);
  if (result.error) {
    showTeamResult('Error: ' + result.error, true);
  }
  loadTeam();
}

async function removeRepo(owner, name) {
  if (!(await confirmAction(`Stop watching ${owner}/${name}? Its review queue and bundle status entries will be cleared.`, { danger: true }))) return;
  await api('DELETE', `/account/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, undefined);
  await loadAccount();
  loadReview();
}

async function setMemberRole(login, role) {
  const result = await api('POST', `/account/team/members/${login}/role`, { role });
  if (result.error) {
    showTeamResult('Error: ' + result.error, true);
  }
  loadTeam();
}

async function updateRepoSetting(row) {
  const checkboxes = [...row.querySelectorAll('.chk-repo-setting')];
  checkboxes.forEach((cb) => { cb.disabled = true; });
  try {
    const body = {};
    checkboxes.forEach((cb) => { body[cb.dataset.setting] = cb.checked; });
    await api('POST', `/account/github/repos/${encodeURIComponent(row.dataset.owner)}/${encodeURIComponent(row.dataset.name)}/settings`, body);
  } finally {
    checkboxes.forEach((cb) => { cb.disabled = !isOwner(); });
  }
}
