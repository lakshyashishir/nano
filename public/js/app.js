import { nanoApi } from './api.js';
import { initWebSocket, onWsEvent } from './websocket.js';

const state = {
  view: 'dashboard',
  agents: [],
  tasks: [],
  logs: [],
  approvals: [],
  stats: {},
  selectedAgentId: null,
  selectedRepo: null,
  selectedRunner: 'cloud',
  wsConnected: false,
  repoSearchTimer: null,
};

const $ = (sel) => document.querySelector(sel);

function showToast(msg) {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function repoChip(repo) {
  if (!repo) return '';
  return `<span class="repo-chip"><img src="${repo.avatar_url || ''}" alt="" />${escapeHtml(repo.full_name || `${repo.owner}/${repo.repo}`)}</span>`;
}

function writeBadge(repo) {
  if (!repo?.permissions) return '';
  const canWrite = repo.permissions.push;
  return `<span class="badge ${canWrite ? 'write' : 'readonly'}" style="margin-left:6px;font-size:0.65rem">${canWrite ? 'writable' : 'read-only'}</span>`;
}

function setView(name) {
  state.view = name;
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  document.getElementById(`view-${name}`)?.classList.add('active');
  document.querySelectorAll('.nav-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === name);
  });
  render();
}

function voidEmpty(title, desc) {
  return `<div class="void-empty"><div class="void-glyph" aria-hidden="true"></div><h3>${title}</h3><p>${desc}</p></div>`;
}

function isAgentOnline(a) {
  if (a.type === 'cloud') return true;
  return Date.now() - a.last_active < 90000;
}

function renderStats() {
  const s = state.stats;
  const runners = s.onlineRunners ?? 0;
  $('#stats-row').innerHTML = `
    <div class="stat-cell"><div class="stat-num">${s.agents ?? 0}</div><div class="stat-lbl">Agents</div></div>
    <div class="stat-cell"><div class="stat-num">${runners}</div><div class="stat-lbl">Runners</div></div>
    <div class="stat-cell"><div class="stat-num">${s.pendingApprovals ?? 0}</div><div class="stat-lbl">Veto</div></div>
    <div class="stat-cell"><div class="stat-num">${s.completedToday ?? 0}</div><div class="stat-lbl">Done</div></div>`;

  const banner = $('#runner-banner');
  if (banner) {
    const waiting = s.pendingLocalTasks ?? 0;
    if (state.selectedRunner === 'local' || waiting > 0) {
      banner.style.display = 'flex';
      banner.innerHTML =
        runners > 0
          ? `<span class="tape-tag">RUN</span><span><strong>${runners} runner(s) online</strong>${waiting ? ` · ${waiting} local queued` : ''}</span>`
          : `<span class="tape-tag">OFF</span><span><strong>No local runner</strong> — run <code>npm run agent:claude</code></span>`;
    } else {
      banner.style.display = 'none';
    }
  }
}

function renderAgents() {
  const el = $('#agents-list');
  if (!state.agents.length) {
    el.innerHTML = voidEmpty('NO AGENTS', 'Cloud agent is always on. Register a local runner with npm run agent:claude.');
    return;
  }
  el.innerHTML = state.agents.map((a) => {
    const online = isAgentOnline(a);
    return `
    <div class="card interactive" data-agent="${a.id}">
      <div class="card-top">
        <div class="card-title">${escapeHtml(a.name)}</div>
        <span class="badge ${a.status}">${a.status}</span>
      </div>
      <div class="card-meta">
        <span class="live-dot ${online ? 'on' : 'off'}" style="width:8px;height:8px"></span>
        <span class="badge ${a.type === 'cloud' ? 'cloud' : 'local'}">${escapeHtml(a.type)}</span>
        <span>${online ? 'Online' : 'Offline'} · ${formatTime(a.last_active)}</span>
      </div>
    </div>`;
  }).join('');

  el.querySelectorAll('[data-agent]').forEach((card) => {
    card.onclick = () => {
      state.selectedAgentId = card.dataset.agent;
      loadAgentDetail();
      setView('agent-detail');
    };
  });
}

function renderTasks() {
  const el = $('#tasks-list');
  if (!state.tasks.length) {
    el.innerHTML = voidEmpty('EMPTY QUEUE', 'Pick a GitHub repo and write a directive.');
    return;
  }
  el.innerHTML = state.tasks.map((t) => {
    const repo = t.github_owner && t.github_repo
      ? { owner: t.github_owner, repo: t.github_repo, full_name: `${t.github_owner}/${t.github_repo}` }
      : null;
    const runner = t.runner === 'local' ? 'local' : 'cloud';
    const runnerBadge = `<span class="badge ${runner === 'local' ? 'local' : 'cloud'}" style="font-size:0.65rem">${runner === 'local' ? 'claude' : 'cloud'}</span>`;
    const waitingRunner = t.status === 'pending' && runner === 'local';
    let resultHtml = '';
    if (t.result) {
      try {
        const r = JSON.parse(t.result);
        const links = [];
        if (r.branchUrl) links.push(`<a href="${escapeHtml(r.branchUrl)}" target="_blank" rel="noopener">branch</a>`);
        if (r.commitUrl) links.push(`<a href="${escapeHtml(r.commitUrl)}" target="_blank" rel="noopener">commit</a>`);
        if (r.prUrl) links.push(`<a href="${escapeHtml(r.prUrl)}" target="_blank" rel="noopener">pull request</a>`);
        const linkHtml = links.length ? `<div class="task-links">${links.join(' · ')}</div>` : '';
        resultHtml = `<div class="card-meta" style="margin-top:8px;color:var(--ok)">${escapeHtml(r.summary || '')}</div>${linkHtml}`;
        if (r.analysisOnly) {
          resultHtml += `<div class="card-meta" style="margin-top:4px;color:var(--warn)">Analysis only — no branch created</div>`;
        }
      } catch { /* ignore */ }
    }
    return `
    <div class="card">
      <div class="card-top">
        <span class="badge ${t.status}">${t.status.replace('_', ' ')}</span>
        <span style="font-size:0.68rem;color:var(--text-ghost)">${formatTime(t.created_at)}</span>
      </div>
      <div class="card-title" style="margin-top:8px">${escapeHtml(t.description)}</div>
      <div class="card-meta">${repo ? repoChip(repo) : ''} ${runnerBadge}${waitingRunner ? ' <span class="badge waiting">waiting for runner</span>' : ''}</div>
      ${resultHtml}
    </div>`;
  }).join('');
}

function renderApprovals() {
  const pending = state.approvals.filter((a) => a.status === 'pending');
  const badge = $('#approval-badge');
  if (pending.length) {
    badge.style.display = 'grid';
    badge.textContent = pending.length;
  } else {
    badge.style.display = 'none';
  }

  const el = $('#approvals-list');
  if (!pending.length) {
    el.innerHTML = voidEmpty('ALL CLEAR', 'Destructive actions will surface here for veto.');
    return;
  }

  el.innerHTML = pending.map((a) => {
    const d = typeof a.details === 'object' ? a.details : {};
    return `
    <div class="card approval-card">
      <div class="action-label">${escapeHtml(a.action_type.replace(/_/g, ' '))}</div>
      <div class="action-body">
        ${d.repo ? `<div>${repoChip({ full_name: d.repo, avatar_url: '' })}</div>` : ''}
        <p style="margin-top:8px">${escapeHtml(d.action || d.task || '')}</p>
        ${d.affectedPaths ? `<pre>${escapeHtml(d.affectedPaths.join('\n'))}</pre>` : ''}
        ${d.canWrite === false ? `<p class="card-meta" style="color:var(--warn);margin-top:8px">Read-only — analyze only</p>` : ''}
        ${d.canWrite ? `<p class="card-meta" style="color:var(--ok);margin-top:8px">Writable — branch, commit, PR</p>` : ''}
      </div>
      <div class="btn-row">
        <button class="btn btn-success" data-approve="${a.id}">Approve</button>
        <button class="btn btn-danger" data-reject="${a.id}">Reject</button>
      </div>
    </div>`;
  }).join('');

  el.querySelectorAll('[data-approve]').forEach((btn) => {
    btn.onclick = async () => {
      btn.disabled = true;
      await nanoApi.approve(btn.dataset.approve);
      showToast('Approved — agent continuing');
      await refreshAll();
    };
  });
  el.querySelectorAll('[data-reject]').forEach((btn) => {
    btn.onclick = async () => {
      btn.disabled = true;
      await nanoApi.reject(btn.dataset.reject);
      showToast('Rejected');
      await refreshAll();
    };
  });
}

function renderLogs(containerId) {
  const id = containerId || (state.view === 'agent-detail' ? 'log-viewer-agent' : 'log-viewer');
  const el = document.getElementById(id);
  if (!el) return;
  if (!state.logs.length) {
    el.innerHTML = `<div class="repo-empty" style="padding:48px 16px">AWAITING SIGNAL…</div>`;
    return;
  }
  el.innerHTML = state.logs.map((l) =>
    `<div class="log-line ${l.level}"><span class="ts">${formatTime(l.timestamp)}</span>${escapeHtml(l.message)}</div>`
  ).join('');
  el.scrollTop = el.scrollHeight;
}

function renderWs() {
  const dot = $('#ws-dot');
  const label = $('#ws-label');
  if (state.wsConnected) {
    dot.classList.remove('off');
    label.textContent = 'Live';
  } else {
    dot.classList.add('off');
    label.textContent = 'Reconnecting';
  }
}

function render() {
  renderStats();
  renderWs();
  if (['dashboard', 'agent-detail'].includes(state.view)) renderAgents();
  if (['tasks', 'dashboard'].includes(state.view)) renderTasks();
  if (['approvals', 'dashboard'].includes(state.view)) renderApprovals();
  if (['logs', 'agent-detail'].includes(state.view)) renderLogs();
}

async function refreshAll() {
  const [stats, agents, tasks, approvals, logs] = await Promise.all([
    nanoApi.getStats(),
    nanoApi.getAgents(),
    nanoApi.getTasks(),
    nanoApi.getApprovals('pending'),
    nanoApi.getLogs({ limit: 150 }),
  ]);
  state.stats = stats.stats;
  state.agents = agents.agents;
  state.tasks = tasks.tasks;
  state.approvals = approvals.approvals;
  state.logs = logs.logs;
  render();
}

async function loadAgentDetail() {
  if (!state.selectedAgentId) return;
  const agent = state.agents.find((a) => a.id === state.selectedAgentId);
  if (!agent) return;
  $('#agent-detail-header').innerHTML = `
    <div class="card">
      <div class="card-top">
        <div class="card-title">${escapeHtml(agent.name)}</div>
        <span class="badge ${agent.status}">${agent.status}</span>
      </div>
      <div class="card-meta"><span class="badge cloud">${agent.type}</span></div>
    </div>`;

  const [logs, tasks] = await Promise.all([
    nanoApi.getLogs({ agent_id: state.selectedAgentId, limit: 80 }),
    nanoApi.getTasks({ agent_id: state.selectedAgentId }),
  ]);
  state.logs = logs.logs;
  renderLogs('log-viewer-agent');

  const tl = $('#agent-tasks-list');
  tl.innerHTML = tasks.tasks.length
    ? tasks.tasks.map((t) => `
      <div class="card">
        <span class="badge ${t.status}">${t.status}</span>
        <div class="card-title" style="margin-top:8px;font-size:0.88rem">${escapeHtml(t.description)}</div>
      </div>`).join('')
    : '<div class="repo-empty">No tasks for this agent</div>';
}

/* ── Repo picker ── */

function selectRepo(repo) {
  state.selectedRepo = repo;
  const sel = $('#repo-selected');
  sel.style.display = 'flex';
  sel.innerHTML = `
    <img src="${repo.avatar_url}" alt="" />
    <div class="info">
      <div class="name">${escapeHtml(repo.full_name)}${writeBadge(repo)}</div>
      <div class="desc">${escapeHtml(repo.description || 'No description')} · ${(repo.stargazers_count || 0).toLocaleString()} stars</div>
    </div>
    <button class="btn-ghost" id="clear-repo" style="width:auto;padding:6px 10px;font-size:0.58rem;letter-spacing:0.1em">CLR</button>`;
  $('#clear-repo').onclick = () => {
    state.selectedRepo = null;
    sel.style.display = 'none';
    updateSubmitBtn();
  };
  $('#repo-list').innerHTML = '';
  updateSubmitBtn();
}

function updateSubmitBtn() {
  const btn = $('#submit-task-btn');
  if (state.selectedRepo) {
    btn.disabled = false;
    btn.textContent = `EXECUTE · ${state.selectedRepo.full_name}`;
  } else {
    btn.disabled = true;
    btn.textContent = 'Select a repo to continue';
  }
}

function renderRepoList(repos) {
  const el = $('#repo-list');
  if (!repos?.length) {
    el.innerHTML = '<div class="repo-empty">No repos found</div>';
    return;
  }
  el.innerHTML = repos.map((r) => `
    <div class="repo-item" data-owner="${escapeHtml(r.owner)}" data-repo="${escapeHtml(r.repo)}">
      <img src="${r.avatar_url}" alt="" loading="lazy" />
      <div class="info">
        <div class="name">${escapeHtml(r.full_name)}${writeBadge(r)}</div>
        <div class="meta">${(r.stargazers_count || 0).toLocaleString()} stars · ${escapeHtml(r.language || '—')}</div>
      </div>
    </div>`).join('');

  el.querySelectorAll('.repo-item').forEach((item) => {
    item.onclick = () => {
      const repo = repos.find((r) => r.owner === item.dataset.owner && r.repo === item.dataset.repo);
      if (repo) selectRepo(repo);
    };
  });
}

async function loadSuggestions() {
  try {
    const { repos, defaultRepo } = await nanoApi.getSuggestions();
    const el = $('#repo-suggestions');
    el.innerHTML = repos.map((r) => `
      <button class="suggestion-chip${r.full_name === defaultRepo ? ' active' : ''}" data-full="${escapeHtml(r.full_name)}">
        <img src="${r.avatar_url}" alt="" />${escapeHtml(r.repo)}${r.full_name === 'lakshyashishir/test-for-hack' ? '<span class="chip-tag">SANDBOX</span>' : ''}
      </button>`).join('');
    el.querySelectorAll('.suggestion-chip').forEach((chip) => {
      chip.onclick = () => selectRepo(repos.find((r) => r.full_name === chip.dataset.full));
    });
    const pick = repos.find((r) => r.full_name === defaultRepo) || repos[0];
    if (pick && state.view === 'new-task' && !state.selectedRepo) {
      selectRepo(pick);
    }
  } catch { /* optional */ }
}

function setupRepoSearch() {
  const input = $('#repo-search');
  input.addEventListener('input', () => {
    clearTimeout(state.repoSearchTimer);
    const q = input.value.trim();
    if (q.length < 2) return;

    state.repoSearchTimer = setTimeout(async () => {
      $('#repo-list').innerHTML = '<div class="repo-empty"><span class="loading"></span> Searching GitHub…</div>';
      try {
        if (q.includes('/') && !q.includes(' ')) {
          const { repo } = await nanoApi.resolveRepo(q);
          renderRepoList([repo]);
        } else {
          const { repos } = await nanoApi.searchRepos(q);
          renderRepoList(repos);
        }
      } catch (err) {
        $('#repo-list').innerHTML = `<div class="repo-empty">${escapeHtml(err.message)}</div>`;
      }
    }, 350);
  });

  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const q = input.value.trim();
      if (!q) return;
      try {
        const { repo } = await nanoApi.resolveRepo(q);
        selectRepo(repo);
      } catch (err) {
        showToast(err.message);
      }
    }
  });
}

function setupRunnerPicker() {
  const hints = {
    cloud: 'Cloud — fast template commits on GitHub. No terminal.',
    local: 'Claude Code — run `npm run agent:claude` on your Mac. Real code edits + PR.',
  };
  document.querySelectorAll('.runner-opt').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.selectedRunner = btn.dataset.runner;
      document.querySelectorAll('.runner-opt').forEach((b) => b.classList.toggle('active', b === btn));
      const hint = $('#runner-hint');
      if (hint) hint.textContent = hints[state.selectedRunner] || hints.cloud;
      renderStats();
    });
  });
}

function setupTaskForm() {
  $('#submit-task-btn').addEventListener('click', async () => {
    const description = $('#task-description').value.trim();
    const repo = state.selectedRepo;
    if (!description || !repo) return;

    const btn = $('#submit-task-btn');
    btn.disabled = true;
    btn.innerHTML = '<span class="loading"></span> Starting agent…';

    try {
      await nanoApi.bootstrap();
      const parsed = await nanoApi.parseTask(description).catch(() => ({}));
      if (parsed.parsed) {
        const box = $('#task-summary');
        box.style.display = 'block';
        box.textContent = `${parsed.parsed.title} · ~${parsed.parsed.estimatedMinutes}min · ${parsed.parsed.priority} priority`;
      }

      await nanoApi.createTask({
        description,
        github_owner: repo.owner,
        github_repo: repo.repo,
        github_branch: repo.default_branch,
        github_url: repo.html_url,
        priority: parsed.parsed?.priority,
        runner: state.selectedRunner,
      });

      const runnerLabel = state.selectedRunner === 'local' ? 'Claude Code' : 'Cloud agent';
      showToast(`${runnerLabel} queued on ${repo.full_name}`);
      $('#task-description').value = '';
      state.selectedRepo = null;
      $('#repo-selected').style.display = 'none';
      updateSubmitBtn();
      await refreshAll();
      setView('logs');
    } catch (err) {
      showToast(err.message);
    } finally {
      btn.disabled = !state.selectedRepo;
      btn.textContent = state.selectedRepo ? `EXECUTE · ${state.selectedRepo.full_name}` : 'SELECT REPO';
    }
  });
}

function setupNav() {
  document.querySelectorAll('.nav-btn').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
  $('#btn-new-task').onclick = () => {
    state.selectedRepo = null;
    $('#repo-selected').style.display = 'none';
    updateSubmitBtn();
    setView('new-task');
    loadSuggestions();
  };
  $('#back-home').onclick = () => setView('dashboard');
  $('#back-agents').onclick = () => setView('dashboard');
  $('#summarize-logs-btn')?.addEventListener('click', async () => {
    try {
      const res = await nanoApi.summarizeLogs(state.logs.slice(-25).map((l) => ({ level: l.level, message: l.message })));
      const box = $('#log-summary');
      box.style.display = 'block';
      box.textContent = res.summary;
    } catch {
      showToast('Summary unavailable');
    }
  });
}

function setupWebSocket() {
  onWsEvent((ev) => {
    if (ev.type === 'ws_connected') { state.wsConnected = true; renderWs(); return; }
    if (ev.type === 'ws_disconnected') { state.wsConnected = false; renderWs(); return; }
    if (ev.type === 'log') {
      state.logs.push({ level: ev.level, message: ev.message, timestamp: ev.timestamp });
      if (state.logs.length > 300) state.logs.shift();
      if (['logs', 'agent-detail'].includes(state.view)) renderLogs();
      return;
    }
    if (ev.type === 'approval_required') {
      showToast(`Approval needed: ${ev.actionType.replace(/_/g, ' ')}`);
      setView('approvals');
      refreshAll();
      return;
    }
    if (['agent_status', 'task_updated', 'task_completed', 'approval_resolved'].includes(ev.type)) {
      refreshAll();
      if (ev.type === 'task_completed') showToast('Task completed');
    }
  });
  initWebSocket();
}

async function init() {
  setupNav();
  setupRepoSearch();
  setupRunnerPicker();
  setupTaskForm();
  setupWebSocket();
  await nanoApi.bootstrap().catch(() => {});
  await refreshAll();
  await loadSuggestions();
  updateSubmitBtn();
  setInterval(refreshAll, 12000);
}

init();
