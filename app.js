// AutoTyper web panel — talks straight to the Supabase Auth and REST APIs.
// No build step, no dependencies, no framework.
'use strict';

(() => {
  const STORAGE = { config: 'autotyper.config', session: 'autotyper.session', theme: 'autotyper.theme' };
  const REFRESH_MS = 4000;        // queue polling
  const TICK_MS = 15000;          // relative timestamps
  const TASK_FIELDS = 'id,text_content,status,attempts,device,error_message,created_at,started_at,completed_at';
  const MS_PER_CHAR = 45;         // the desktop app's default base_delay_ms

  const $ = (id) => document.getElementById(id);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));

  let config = loadConfig();
  let session = loadSession();
  let tasks = null;               // null = not loaded yet (skeleton)
  let filter = 'all';
  let pollTimer = null;
  let tickTimer = null;
  let toastTimer = null;
  let authMode = 'signin';
  let project = { state: 'unknown', detail: '' };
  const themeMedia = window.matchMedia('(prefers-color-scheme: dark)');

  // ------------------------------------------------------------------ storage
  function loadConfig() {
    const baked = window.AUTOTYPER_CONFIG || {};
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(STORAGE.config) || '{}'); } catch { saved = {}; }
    return {
      url: String(saved.url || baked.supabaseUrl || '').replace(/\/+$/, ''),
      key: String(saved.key || baked.supabaseAnonKey || ''),
    };
  }

  function remember(key, value) {
    try { localStorage.setItem(key, value); } catch { /* private mode: ignore */ }
  }

  function loadSession() {
    try { return JSON.parse(localStorage.getItem(STORAGE.session) || 'null'); } catch { return null; }
  }

  function storeSession(data) {
    session = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
      email: (data.user && data.user.email) || (session && session.email) || '',
      user_id: (data.user && data.user.id) || (session && session.user_id) || '',
    };
    remember(STORAGE.session, JSON.stringify(session));
  }

  function forgetSession() {
    session = null;
    try { localStorage.removeItem(STORAGE.session); } catch { /* ignore */ }
  }

  // ---------------------------------------------------------------------- api
  function errorText(data, status) {
    if (data && typeof data === 'object') {
      return data.msg || data.message || data.error_description || data.error || data.hint
        || (data.code ? `${data.code}: check the schema and policies` : `HTTP ${status}`);
    }
    return data ? String(data) : `HTTP ${status}`;
  }

  async function api(path, options = {}) {
    const { method = 'GET', body, auth = true, prefer } = options;
    const headers = { apikey: config.key, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth && session && session.access_token) headers.Authorization = `Bearer ${session.access_token}`;
    if (prefer) headers.Prefer = prefer;

    const response = await fetch(config.url + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await response.text();
    let data = null;
    if (raw) { try { data = JSON.parse(raw); } catch { data = raw; } }
    if (!response.ok) {
      const error = new Error(errorText(data, response.status));
      error.status = response.status;
      error.payload = data;
      throw error;
    }
    return data;
  }

  // --------------------------------------------------------------------- auth
  async function signIn(email, password) {
    const data = await api('/auth/v1/token?grant_type=password', {
      method: 'POST', body: { email, password }, auth: false,
    });
    storeSession(data);
  }

  // false = Supabase still wants the e-mail confirmed before a session exists.
  async function signUp(email, password) {
    const data = await api('/auth/v1/signup', { method: 'POST', body: { email, password }, auth: false });
    if (!data || !data.session) return false;
    storeSession(data);
    return true;
  }

  async function refreshSession() {
    if (!session || !session.refresh_token) throw new Error('not signed in');
    const data = await api('/auth/v1/token?grant_type=refresh_token', {
      method: 'POST', body: { refresh_token: session.refresh_token }, auth: false,
    });
    storeSession(data);
  }

  async function withSession() {
    if (!session) throw new Error('not signed in');
    if (session.expires_at - 60 <= Math.floor(Date.now() / 1000)) await refreshSession();
  }

  async function signOut() {
    try { await api('/auth/v1/logout', { method: 'POST', body: {} }); } catch { /* token may be gone already */ }
    forgetSession();
    stopPolling();
    tasks = null;
    show('authView');
    renderHeader();
  }

  // ------------------------------------------------------------------- queue
  async function fetchTasks() {
    await withSession();
    return api(`/rest/v1/typing_tasks?select=${TASK_FIELDS}&order=created_at.desc&limit=200`);
  }

  async function addTask(text) {
    await withSession();
    return api('/rest/v1/typing_tasks', {
      method: 'POST',
      body: { user_id: session.user_id, text_content: text },
      prefer: 'return=representation',
    });
  }

  async function setStatus(id, status) {
    await withSession();
    const patch = { status };
    if (status === 'queued') Object.assign(patch, { started_at: null, completed_at: null, error_message: null, device: null });
    return api(`/rest/v1/typing_tasks?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH', body: patch, prefer: 'return=representation',
    });
  }

  async function removeTask(id) {
    await withSession();
    return api(`/rest/v1/typing_tasks?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  async function removeFinished() {
    await withSession();
    return api('/rest/v1/typing_tasks?status=in.(completed,failed)', { method: 'DELETE' });
  }

  // -------------------------------------------------------------- healthcheck
  const projectRef = () => String(config.url).replace(/^https?:\/\//, '').split('.')[0];

  // Asks the Data API for one row with the anon key only. That tells us whether
  // the schema is installed before anybody signs in.
  async function checkProject() {
    if (!config.url || !config.key) {
      project = { state: 'none', detail: 'No project configured' };
      return renderProject();
    }
    if (!/^https?:\/\//.test(config.url)) {
      project = { state: 'bad', detail: 'The project URL must start with https://' };
      return renderProject();
    }
    try {
      const response = await fetch(`${config.url}/rest/v1/typing_tasks?select=id&limit=1`, {
        headers: { apikey: config.key, Accept: 'application/json' },
      });
      const text = await response.text();
      if (/Could not find the table|PGRST205|Could not find the function|PGRST202/i.test(text)) {
        project = { state: 'missing', detail: 'Schema not installed yet' };
      } else if (/Invalid API key|No API key found|invalid jwt/i.test(text)) {
        project = { state: 'bad', detail: 'The anon key was rejected' };
      } else if (/permission denied/i.test(text) || response.ok) {
        project = { state: 'ok', detail: 'Schema installed, anon key locked out by RLS as expected' };
      } else {
        project = { state: 'bad', detail: errorText(null, response.status) };
      }
    } catch {
      project = { state: 'unreachable', detail: 'Could not reach the project' };
    }
    renderProject();
  }

  function renderProject() {
    $('projectName').textContent = config.url ? projectRef() : 'no project';
    const dot = $('projectDot');
    dot.className = 'status-dot ' + (project.state === 'ok' ? 'ok' : project.state === 'missing' || project.state === 'unreachable' ? 'warn' : project.state === 'bad' ? 'bad' : '');
    $('projectChip').title = project.detail || 'Change the Supabase project';

    const banner = $('schemaBanner');
    if (project.state === 'missing') {
      banner.className = 'banner';
      banner.innerHTML =
        '<svg class="icon"><use href="#i-alert"/></svg><div>' +
        '<strong>This project has no AutoTyper schema yet</strong>' +
        'Run <code>supabase/schema.sql</code> in the SQL editor of <code>' + escapeHtml(projectRef()) + '</code> — ' +
        'it creates the queue table, the row level security policies and the two RPCs. ' +
        '<a href="https://supabase.com/dashboard/project/' + encodeURIComponent(projectRef()) + '/sql/new" target="_blank" rel="noopener">Open the SQL editor</a>.' +
        '</div>';
    } else if (project.state === 'unreachable' || project.state === 'bad') {
      banner.className = 'banner';
      banner.innerHTML =
        '<svg class="icon"><use href="#i-alert"/></svg><div>' +
        '<strong>' + escapeHtml(project.detail) + '</strong>' +
        'Check the project URL and the anon key in <a href="#" data-action="open-settings">server settings</a>.' +
        '</div>';
    } else {
      banner.className = 'banner hidden';
      banner.innerHTML = '';
    }
  }

  // ------------------------------------------------------------------- theme
  const THEMES = ['system', 'light', 'dark'];

  function applyTheme(mode) {
    const dark = mode === 'dark' || (mode === 'system' && themeMedia.matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.documentElement.dataset.themeMode = mode;
    remember(STORAGE.theme, mode);
    const icon = mode === 'system' ? 'i-monitor' : dark ? 'i-moon' : 'i-sun';
    $('themeIcon').innerHTML = '<use href="#' + icon + '"/>';
    $('themeToggle').title = 'Theme: ' + mode;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#0b0d13' : '#f7f7f4');
  }
  // ----------------------------------------------------------------- rendering
  function show(viewId) {
    for (const id of ['setupView', 'authView', 'appView']) {
      $(id).classList.toggle('hidden', id !== viewId);
    }
  }

  function renderHeader() {
    $('userEmail').textContent = session && session.email ? session.email : '';
    $('signOutBtn').classList.toggle('hidden', !session);
    $('settingsBtn').classList.toggle('hidden', !config.url);
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function statusLabel(status) {
    return {
      queued: 'queued',
      in_progress: 'typing now',
      completed: 'completed',
      failed: 'failed',
    }[status] || status || 'unknown';
  }

  function timeAgo(iso) {
    if (!iso) return '';
    const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
    if (seconds < 60) return seconds + 's ago';
    if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
    if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
    return Math.floor(seconds / 86400) + 'd ago';
  }

  // Rough answer to "how long will this take?" using the app's default speed.
  function estimateDuration(chars) {
    if (!chars) return '';
    const seconds = Math.round((chars * MS_PER_CHAR) / 1000);
    if (seconds < 60) return '\u2248 ' + seconds + 's at default speed';
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    return '\u2248 ' + minutes + 'm' + (rest ? ' ' + rest + 's' : '') + ' at default speed';
  }

  function visibleTasks() {
    if (!tasks) return [];
    return filter === 'all' ? tasks : tasks.filter((task) => task.status === filter);
  }

  let statsSignature = '';

  function renderStats() {
    const count = (status) => (tasks || []).filter((task) => task.status === status).length;
    const cells = [
      ['queued', 'queued'],
      ['in_progress', 'typing'],
      ['completed', 'done'],
      ['failed', 'failed'],
    ];
    // Rewriting the buttons on every poll interrupted clicks that spanned a
    // re-render, so only touch the DOM when the numbers or the filter change.
    const signature = cells.map(([status]) => count(status)).join(',') + '|' + filter;
    if (signature === statsSignature) return;
    statsSignature = signature;
    $('stats').innerHTML = cells.map(([status, label]) =>
      '<button class="stat" type="button" data-status="' + status + '" aria-pressed="' + (filter === status) + '">' +
      '<span class="stat-value">' + count(status) + '</span>' +
      '<span class="stat-label">' + label + '</span>' +
      '</button>').join('');
  }

  let liveSignature = '';

  function renderLive() {
    const live = $('liveBanner');
    const active = (tasks || []).find((task) => task.status === 'in_progress');
    if (!active) {
      if (liveSignature === 'none') return;
      liveSignature = 'none';
      live.className = 'live hidden';
      live.innerHTML = '';
      return;
    }
    // Rebuild at most once per 15s window while a task is running.
    const signature = active.id + '|' + (active.device || '') + '|' +
      Math.floor((Date.now() - new Date(active.started_at || Date.now()).getTime()) / 15000);
    if (signature === liveSignature) return;
    liveSignature = signature;
    live.className = 'live';
    live.innerHTML =
      '<span class="pulse"></span><div><strong>The desktop app is typing right now.</strong> ' +
      '<span class="muted">' + escapeHtml(active.device || 'unknown device') + ' \u00b7 started ' + timeAgo(active.started_at) +
      ' \u00b7 ' + active.text_content.length + ' characters</span></div>';
  }

  function taskRow(task) {
    const bits = [
      timeAgo(task.created_at),
      task.text_content.length + ' characters',
      task.attempts ? 'attempt ' + task.attempts : '',
      task.device ? escapeHtml(task.device) : '',
    ].filter(Boolean);
    const meta = bits.map((bit) => '<span class="muted">' + bit + '</span>').join('<span class="dot"></span>');
    const body = task.text_content.length > 900 ? task.text_content.slice(0, 900) + '\u2026' : task.text_content;
    const actions = [];
    if (task.status !== 'queued') {
      actions.push('<button class="btn ghost small" type="button" data-action="requeue" data-id="' + task.id + '">' +
        '<svg class="icon"><use href="#i-undo"/></svg>Re-queue</button>');
    }
    actions.push('<button class="btn ghost small danger" type="button" data-action="delete" data-id="' + task.id + '">' +
      '<svg class="icon"><use href="#i-trash"/></svg>Delete</button>');

    return '<article class="task" data-status="' + task.status + '">' +
      '<div class="task-head">' +
      '<span class="chip ' + task.status + '">' + statusLabel(task.status) + '</span>' +
      '<span class="task-meta">' + meta + '</span>' +
      '</div>' +
      '<pre class="task-text">' + escapeHtml(body) + '</pre>' +
      (task.error_message ? '<p class="task-error"><svg class="icon"><use href="#i-alert"/></svg>' + escapeHtml(task.error_message) + '</p>' : '') +
      '<div class="task-actions">' + actions.join('') + '</div>' +
      '</article>';
  }

  let tasksSignature = '';
  let tasksRenderedAt = 0;

  function renderTasks(force) {
    const list = $('taskList');
    if (tasks === null) {
      if (tasksSignature === 'loading') return;
      tasksSignature = 'loading';
      list.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
      return;
    }
    // Same guard as the stats: rebuild for real changes, and otherwise only every
    // 15s so the "2m ago" labels stay honest without constant DOM churn.
    const signature = JSON.stringify((tasks || []).map((task) =>
      [task.id, task.status, task.attempts, task.device, task.error_message, task.started_at, task.text_content.length])) + '|' + filter;
    const stale = Date.now() - tasksRenderedAt > 15000;
    if (!force && signature === tasksSignature && !stale) return;
    tasksSignature = signature;
    tasksRenderedAt = Date.now();
    const shown = visibleTasks();
    if (!shown.length) {
      list.innerHTML = '<div class="empty"><svg class="icon"><use href="#i-keyboard"/></svg><p>' +
        (tasks.length ? 'No tasks in this filter.' : 'Nothing queued yet — add the first task on the left.') +
        '</p></div>';
      return;
    }
    list.innerHTML = shown.map(taskRow).join('');
  }

  function renderFilters() {
    for (const button of $$('.filter')) {
      const active = button.dataset.filter === filter;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    }
  }

  function render() {
    renderStats();
    renderLive();
    renderTasks();
    renderFilters();
    renderHeader();
  }

  function toast(message, isError) {
    const node = $('toast');
    node.textContent = message;
    node.className = 'toast' + (isError ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.className = 'toast hidden'; }, isError ? 7000 : 3200);
  }

  // ------------------------------------------------------------------ polling
  let lastProjectCheck = 0;

  async function refreshTasks(options = {}) {
    try {
      const rows = await fetchTasks();
      tasks = Array.isArray(rows) ? rows : [];
      render();
      // Self-heal the health banner once the schema has been installed.
      if (project.state !== 'ok' && Date.now() - lastProjectCheck > 10000) {
        lastProjectCheck = Date.now();
        checkProject();
      }
    } catch (error) {
      if (!options.silent) handleError(error);
    }
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(() => {
      if (!$('autoRefresh').checked || document.hidden) return;
      refreshTasks({ silent: true });
    }, REFRESH_MS);
    tickTimer = setInterval(() => {
      if (document.hidden || !tasks || !tasks.length) return;
      renderLive();
      renderStats();
      renderTasks();   // keeps "2m ago" honest
    }, TICK_MS);
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    if (tickTimer) clearInterval(tickTimer);
    pollTimer = null;
    tickTimer = null;
  }

  function handleError(error) {
    const message = error && error.message ? error.message : String(error);
    if (/PGRST205|Could not find the table|PGRST202|Could not find the function/i.test(message)) {
      project = { state: 'missing', detail: 'Schema not installed yet' };
      renderProject();
      toast('Database schema missing — run supabase/schema.sql in your Supabase SQL editor.', true);
      return;
    }
    if (/jwt|token|not signed in|expired|invalid claim/i.test(message)) {
      forgetSession();
      stopPolling();
      show('authView');
      renderHeader();
      toast('Your session expired — please sign in again.', true);
      return;
    }
    toast(message, true);
  }

  // -------------------------------------------------------------------- views
  function showSetup() {
    $('setupUrl').value = config.url;
    $('setupKey').value = config.key;
    $('setupCancel').classList.toggle('hidden', !config.url);
    show('setupView');
    renderHeader();
  }

  async function enterApp() {
    tasks = null;
    show('appView');
    renderHeader();
    render();                     // skeletons until the first load lands
    await refreshTasks();
    startPolling();
  }

  function updateCharCount() {
    const chars = $('taskText').value.length;
    $('charCount').textContent = chars + (chars === 1 ? ' character' : ' characters');
    $('estimate').textContent = estimateDuration(chars);
  }

  // --------------------------------------------------------------------- boot
  async function boot() {
    applyTheme(document.documentElement.dataset.themeMode || 'system');
    renderHeader();
    updateCharCount();

    if (!config.url || !config.key) { showSetup(); return; }
    checkProject();

    if (!session) { show('authView'); return; }
    try {
      await refreshSession();
    } catch {
      forgetSession();
      show('authView');
      return;
    }
    await enterApp();
  }

  // ------------------------------------------------------------------- events
  $('themeToggle').addEventListener('click', () => {
    const current = document.documentElement.dataset.themeMode || 'system';
    applyTheme(THEMES[(THEMES.indexOf(current) + 1) % THEMES.length]);
  });

  themeMedia.addEventListener('change', () => {
    if ((document.documentElement.dataset.themeMode || 'system') === 'system') applyTheme('system');
  });

  $('projectChip').addEventListener('click', showSetup);
  $('settingsBtn').addEventListener('click', showSetup);
  $('setupCancel').addEventListener('click', () => show(session ? 'appView' : 'authView'));

  $('setupSave').addEventListener('click', async () => {
    const url = $('setupUrl').value.trim().replace(/\/+$/, '');
    const key = $('setupKey').value.trim();
    if (!/^https?:\/\/.+/.test(url)) { toast('Enter the full project URL, e.g. https://abcd.supabase.co', true); return; }
    if (!key) { toast('Paste the anon / publishable key.', true); return; }
    config = { url, key };
    remember(STORAGE.config, JSON.stringify(config));
    renderHeader();
    await checkProject();
    if (session) { enterApp(); }
    else { show('authView'); toast('Project saved — now sign in.'); }
  });

  for (const tab of $$('.tab')) {
    tab.addEventListener('click', () => {
      authMode = tab.dataset.tab;
      for (const other of $$('.tab')) other.classList.toggle('active', other === tab);
      $('authSubmit').textContent = authMode === 'signin' ? 'Sign in' : 'Create account';
      $('authPassword').autocomplete = authMode === 'signin' ? 'current-password' : 'new-password';
    });
  }

  $('authForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const email = $('authEmail').value.trim();
    const password = $('authPassword').value;
    if (!email || !password) return;
    const button = $('authSubmit');
    button.disabled = true;
    try {
      if (authMode === 'signin') {
        await signIn(email, password);
        $('authPassword').value = '';
        toast('Signed in.');
        await enterApp();
      } else {
        const signedIn = await signUp(email, password);
        $('authPassword').value = '';
        if (signedIn) {
          toast('Account created — you are signed in.');
          await enterApp();
        } else {
          toast('Account created. Confirm the e-mail address, then sign in.', true);
          authMode = 'signin';
          for (const other of $$('.tab')) other.classList.toggle('active', other.dataset.tab === 'signin');
          $('authSubmit').textContent = 'Sign in';
        }
      }
    } catch (error) {
      handleError(error);
    } finally {
      button.disabled = false;
    }
  });

  $('signOutBtn').addEventListener('click', signOut);

  $('taskText').addEventListener('input', updateCharCount);
  $('taskText').addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      $('queueBtn').click();
    }
  });

  $('queueBtn').addEventListener('click', async () => {
    const text = $('taskText').value;
    if (!text.trim()) { toast('Type or paste the text first.', true); return; }
    const button = $('queueBtn');
    button.disabled = true;
    button.classList.add('busy');
    $('queueBtnLabel').textContent = 'Queueing\u2026';
    try {
      await addTask(text);
      $('taskText').value = '';
      updateCharCount();
      toast('Task queued — the desktop app will pick it up.');
      await refreshTasks();
    } catch (error) {
      handleError(error);
    } finally {
      button.disabled = false;
      button.classList.remove('busy');
      $('queueBtnLabel').textContent = 'Add to queue';
    }
  });

  $('refreshBtn').addEventListener('click', () => refreshTasks());

  $('clearFinishedBtn').addEventListener('click', async () => {
    try {
      await removeFinished();
      toast('Finished tasks removed.');
      await refreshTasks();
    } catch (error) {
      handleError(error);
    }
  });

  $('filters').addEventListener('click', (event) => {
    const button = event.target.closest('.filter');
    if (!button) return;
    filter = button.dataset.filter;
    render();
  });

  $('stats').addEventListener('click', (event) => {
    const cell = event.target.closest('.stat');
    if (!cell) return;
    filter = filter === cell.dataset.status ? 'all' : cell.dataset.status;
    render();
  });

  $('taskList').addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const action = button.dataset.action;
    const id = button.dataset.id;
    button.disabled = true;
    try {
      if (action === 'requeue') { await setStatus(id, 'queued'); toast('Task queued again.'); }
      else if (action === 'delete') { await removeTask(id); toast('Task deleted.'); }
      await refreshTasks();
    } catch (error) {
      handleError(error);
    }
  });

  document.addEventListener('click', (event) => {
    const link = event.target.closest('[data-action="open-settings"]');
    if (link) { event.preventDefault(); showSetup(); }
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && session) refreshTasks({ silent: true });
  });

  boot();
})();
