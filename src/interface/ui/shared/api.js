// Every failure — network error, non-2xx status, or a non-JSON body (e.g. a 500 HTML
// error page) — comes back as `{ error, status? }` rather than a rejected promise or a
// half-parsed body, so callers have exactly one thing to check: `result.error`.
async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  let r;
  try {
    r = await fetch(path, opts);
  } catch {
    return { error: 'Network error — could not reach the server' };
  }
  if (r.status === 401) {
    showSigninGate();
    return { error: 'Sign in required', status: 401 };
  }
  let parsed;
  let parseFailed = false;
  try {
    parsed = await r.json();
  } catch {
    parseFailed = true;
  }
  if (!r.ok) {
    const message = !parseFailed && parsed && parsed.error
      ? parsed.error
      : `Request failed (${r.status}${r.statusText ? ' ' + r.statusText : ''})`;
    return { error: message, status: r.status };
  }
  if (parseFailed) {
    return { error: 'Unexpected non-JSON response from the server', status: r.status };
  }
  return parsed;
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
  if (!showToast._dismissWired) {
    showToast._dismissWired = true;
    toast.addEventListener('click', () => {
      clearTimeout(showToast._t);
      toast.classList.remove('visible');
    });
  }
  clearTimeout(showToast._t);
  // Error toasts stick around long enough to actually read (and can be tap-dismissed
  // sooner); success/notice toasts keep the quick auto-dismiss.
  const ttl = (tone || 'error') === 'error' ? 10000 : 3500;
  showToast._t = setTimeout(() => toast.classList.remove('visible'), ttl);
}

function showError(message) {
  showToast(message, 'error');
}

// Inline error state for a pane list that failed to load, replacing a "Loading…"
// placeholder that would otherwise sit there forever. `retryCall` must be a complete,
// global, zero-side-effect-on-parse call expression (e.g. 'loadQueue()' or
// "showBundleDetail('abc')") since this renders through innerHTML/onclick.
function paneErrorHtml(message, retryCall, className) {
  return `<div class="${className || 'empty'}">Could not load — ${escapeHtml(message)}<br>
    <button class="btn" style="margin-top:var(--space-2)" onclick="${retryCall}">Retry</button></div>`;
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

async function abortQueueEntry(bundleId, mergedCount, totalCount, btn) {
  const message = mergedCount > 0
    ? `Abort this bundle? ${mergedCount} of ${totalCount} member PRs already merged and will stay merged — aborting only stops Quire from retrying the rest. Nothing is reverted.`
    : 'Abort this bundle? It will stop being retried and remain in the queue marked as aborted.';
  if (!(await confirmAction(message))) return;
  const result = await withPending(btn, 'Aborting…', () => api('POST', `/queue/${bundleId}/abort`, undefined));
  if (result.error) {
    showError('Could not abort bundle: ' + result.error);
    return;
  }
  loadQueue();
}

async function disconnectInstallation(installationId, btn) {
  if (!(await confirmAction('Disconnect this GitHub App installation?'))) return;
  const result = await withPending(btn, 'Disconnecting…', () => api('POST', `/account/github/disconnect/${installationId}`, undefined));
  if (result.error) {
    showError('Could not disconnect installation: ' + result.error);
    return;
  }
  loadAccount();
}

async function overturnAudit(entryId, btn) {
  const result = await withPending(btn, 'Marking…', () => api('POST', `/audit/${entryId}/overturn`));
  if (result.error) {
    showError('Could not overturn audit entry: ' + result.error);
    return;
  }
  loadAudit();
}

async function promote(bundleId, btn) {
  const result = await withPending(btn, 'Unshelving…', () => api('DELETE', `/shelf/${bundleId}`));
  if (result.error) {
    showError('Could not unshelf bundle: ' + result.error);
    return;
  }
  loadShelf();
  loadReview();
}

async function reattemptQueueEntry(bundleId, btn) {
  const result = await withPending(btn, 'Retrying…', () => api('POST', `/queue/${bundleId}/retry`, undefined));
  if (result.error) {
    showError('Could not reattempt bundle: ' + result.error);
    return;
  }
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

async function removeRepo(owner, name, btn) {
  if (!(await confirmAction(`Stop watching ${owner}/${name}? Its review queue and bundle status entries will be cleared.`, { danger: true }))) return;
  const result = await withPending(btn, 'Removing…', () => api('DELETE', `/account/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, undefined));
  if (result.error) {
    showError('Could not remove repo: ' + result.error);
    return;
  }
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
