let loadedTeamId = null;
let myRole = null;

// Client-side hiding is UX only — requireRole on the server is the real enforcement, so
// getting this wrong just means a disabled-looking button, not a security hole.
function canManageMembers() { return myRole === 'owner' || myRole === 'admin'; }
function isOwner() { return myRole === 'owner'; }

// Owner-only controls live outside the Team panel too (queue processing, auto-merge) —
// applied here so every loadTeam() call keeps them in sync with the caller's current role.
// Rename/invite are gated to owner+admin server-side (PATCH /account/team, POST
// /account/team/invite) — kept in sync with canManageMembers() for the same reason.
function applyRoleVisibility() {
	document.getElementById('btn-process').classList.toggle('hidden', !isOwner());
	document.querySelectorAll('.chk-repo-setting').forEach((el) => { el.disabled = !isOwner(); });
	document.querySelectorAll('.btn-remove-repo').forEach((el) => { el.disabled = !canManageMembers(); });
	document.getElementById('team-name-input').disabled = !canManageMembers();
	document.getElementById('btn-team-rename').classList.toggle('hidden', !canManageMembers());
	document.getElementById('btn-team-invite').classList.toggle('hidden', !canManageMembers());
}

async function loadTeam() {
	const statusEl = document.getElementById('team-status');
	const resultEl = document.getElementById('team-result');
	resultEl.classList.add('hidden');

	const status = await api('GET', '/account/team');
	if (status.error) {
		statusEl.textContent = 'Error: ' + status.error;
		return;
	}
	loadedTeamId = status.teamId;
	myRole = status.role;
	statusEl.innerHTML = `On <span class="login">${escapeHtml(status.name)}</span> as ${escapeHtml(status.role)}`;
	document.getElementById('team-name-input').value = status.name;
	document.getElementById('team-members-list').innerHTML = status.members.map(memberRowHtml).join('');
	applyRoleVisibility();

	const { teams } = await api('GET', '/account/team/list');
	document.getElementById('team-switcher').innerHTML = (teams || [])
		.map((t) => `<option value="${escapeHtml(t.teamId)}" ${t.active ? 'selected' : ''}>${escapeHtml(t.name)}</option>`)
		.join('');
	renderHeaderTeam(status.name, teams || []);
}

// Shows a plain team-name badge when the login belongs to only one team, or a select
// (its currently active/default team, changed immediately on pick) once it belongs to
// more than one — no point cluttering the header with a dropdown that only ever offers
// one choice.
document.getElementById('header-team-switcher').addEventListener('change', async (e) => {
	const result = await api('POST', '/account/team/switch', { teamId: e.target.value });
	if (result.error) {
		showError('Error: ' + result.error);
		return;
	}
	await refreshAfterTeamChange();
});

document.getElementById('team-switcher').addEventListener('change', async (e) => {
	const result = await api('POST', '/account/team/switch', { teamId: e.target.value });
	if (result.error) {
		showTeamResult('Error: ' + result.error, true);
		return;
	}
	await refreshAfterTeamChange();
});

document.getElementById('btn-team-rename').addEventListener('click', async () => {
	const name = document.getElementById('team-name-input').value.trim();
	if (!name) return;
	const result = await api('PATCH', '/account/team', { name });
	if (result.error) {
		showTeamResult('Error: ' + result.error, true);
		return;
	}
	showTeamResult('Team renamed.', false);
	loadTeam();
});

document.getElementById('btn-team-invite').addEventListener('click', async () => {
	const result = await api('POST', '/account/team/invite', undefined);
	if (result.error) {
		showTeamResult('Error: ' + result.error, true);
		return;
	}
	try {
		await navigator.clipboard.writeText(result.inviteUrl);
		showTeamResult('Invite link copied to clipboard (valid for 7 days).', false);
	} catch {
		showTeamResult('Invite link: ' + result.inviteUrl, false);
	}
});

document.getElementById('btn-team-create').addEventListener('click', async () => {
	const input = document.getElementById('team-create-input');
	const name = input.value.trim();
	if (!name) return;
	const result = await api('POST', '/account/team/create', { name });
	if (result.error) {
		showTeamResult('Error: ' + result.error, true);
		return;
	}
	input.value = '';
	await refreshAfterTeamChange();
});

document.getElementById('btn-team-leave').addEventListener('click', async () => {
	if (!loadedTeamId || !(await confirmAction('Leave this team?'))) return;
	const result = await api('POST', '/account/team/leave', { teamId: loadedTeamId });
	if (result.error) {
		showTeamResult('Error: ' + result.error, true);
		return;
	}
	await refreshAfterTeamChange();
});
