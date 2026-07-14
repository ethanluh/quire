const repoPanel = document.getElementById('repo-panel');
const installBtn = document.getElementById('btn-account-install');
const accountDisconnectAllBtn = document.getElementById('btn-account-disconnect-all');
let loadedInstallations = [];

function showAccountResult(message, isError) {
	const resultEl = document.getElementById('account-result');
	resultEl.textContent = message;
	resultEl.className = isError ? 'result-msg error' : 'result-msg';
	resultEl.classList.remove('hidden');
}

// Per-page tuning for loadAccount()'s connected-state rendering: desktop shows an
// automation-status line and a "connect an already-installed app" shortcut list that
// mobile's settings sheet has no room/need for. Set once by each page before loadAccount()
// is first called (see index.html/mobile.html) — mobile leaves this at its no-op default.
let accountHooks = {};

async function loadAccount() {
	const statusEl = document.getElementById('account-status');
	const resultEl = document.getElementById('account-result');
	const listEl = document.getElementById('installations-list');
	const copyEl = document.getElementById('account-connect-copy');
	resultEl.classList.add('hidden');
	const status = await api('GET', '/account/github/status');
	loadedInstallations = status.installations || [];
	const watchedRepos = status.repos || [];
	installBtn.disabled = false;
	if (status.connected) {
		statusEl.textContent = `Connected to ${loadedInstallations.length} installation${loadedInstallations.length === 1 ? '' : 's'}:`;
		listEl.innerHTML = loadedInstallations.map(installationHtml).join('');
		copyEl.textContent = 'Install on another organization or account.';
		accountDisconnectAllBtn.classList.remove('hidden');
		repoPanel.classList.remove('hidden');
		if (accountHooks.onConnected) accountHooks.onConnected(watchedRepos);
		renderWatchedRepos(watchedRepos);
		// loadRepos() resolves once it's confirmed live, per-installation whether each watched
		// repo's GitHub App installation still exists — re-render with that info once it's in,
		// rather than blocking the first paint on a live GitHub round trip.
		loadRepos(watchedRepos).then((failedAccounts) => {
			const revokedInstallationIds = new Set(
				(failedAccounts || []).filter((f) => f.revoked).map((f) => f.installationId),
			);
			if (revokedInstallationIds.size) renderWatchedRepos(watchedRepos, revokedInstallationIds);
		});
	} else {
		statusEl.textContent = watchedRepos.length
			? `Not connected. Will resume watching ${watchedRepos.map((r) => `${r.owner}/${r.name}`).join(', ')} once reconnected.`
			: 'Not connected.';
		listEl.innerHTML = '';
		copyEl.textContent = 'Install the Quire GitHub App on an organization or repository so Quire can merge and revert PRs on its behalf.';
		accountDisconnectAllBtn.classList.add('hidden');
		repoPanel.classList.add('hidden');
	}
	if (accountHooks.afterRender) accountHooks.afterRender();
	renderHeaderRepo(status.selectedRepo);
}

// A lighter-weight sibling of loadAccount() for the header: just the selected repo, on
// every page load, without also paying for loadAccount()'s installations/repo-list fetches
// (those only matter once Settings is actually open).
async function loadHeaderRepo() {
	const status = await api('GET', '/account/github/status');
	renderHeaderRepo(status.selectedRepo);
}

accountDisconnectAllBtn.addEventListener('click', async () => {
	if (!(await confirmAction('Disconnect all GitHub App installations? This clears the current selection and cached repo lists.', { danger: true }))) return;
	await api('POST', '/account/github/disconnect-all', undefined);
	loadAccount();
});

installBtn.addEventListener('click', async () => {
	if (!(await confirmAction("Install the Quire GitHub App? You'll choose which repos to grant access to on GitHub's side.", { confirmLabel: 'Continue to GitHub' }))) return;
	// Disabled for the round trip to /install/start so a fast double-click can't fire it
	// twice before location.href navigates away — the server is idempotent either way,
	// but there's no reason to rely on that alone.
	installBtn.disabled = true;
	const result = await api('POST', '/account/github/install/start', undefined);
	if (result.error) {
		showAccountResult('Error: ' + result.error, true);
		installBtn.disabled = false;
		return;
	}
	location.href = result.installUrl;
});

// A team can watch several repos at once, each with its own auto-merge/flag-conflicts/
// deep-investigation settings — one row per repo instead of one global checkbox row.
document.getElementById('watched-repos-list').addEventListener('change', (e) => {
	if (!e.target.classList.contains('chk-repo-setting')) return;
	updateRepoSetting(e.target.closest('.watched-repo-row'));
});

document.getElementById('watched-repos-list').addEventListener('click', (e) => {
	if (!e.target.classList.contains('btn-remove-repo')) return;
	const row = e.target.closest('.watched-repo-row');
	removeRepo(row.dataset.owner, row.dataset.name, e.target);
});

async function loadLlmAccount() {
	const statusEl = document.getElementById('llm-account-status');
	const resultEl = document.getElementById('llm-account-result');
	resultEl.classList.add('hidden');
	const status = await api('GET', '/account/llm/status');
	const connectFormEl = document.getElementById('llm-connect-form');
	const disconnectBtn = document.getElementById('btn-llm-disconnect');
	if (status.connected) {
		statusEl.textContent = `Connected to ${status.provider}`;
		connectFormEl.classList.add('hidden');
		disconnectBtn.classList.remove('hidden');
	} else {
		statusEl.textContent = 'Not connected. Falling back to environment configuration.';
		connectFormEl.classList.remove('hidden');
		disconnectBtn.classList.add('hidden');
	}
}
