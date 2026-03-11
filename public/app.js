// ─── BOTCOIN Miner Dashboard — Frontend JS ──────────────
// SSE log streaming, REST controls, session-based multi-user.

const API = '';  // same origin

// ─── State ──────────────────────────────────────────────

let evtSource = null;
let verifyEnabled = false;
let autoScroll = true;
let logCount = 0;
let uptimeStart = null;
let uptimeTimer = null;
let sessionId = null;

// ─── Init ───────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
    connectSSE();
    loadModels();
    await refreshStatus();
    startUptimeTimer();
    setInterval(refreshStatus, 10000);
    setInterval(refreshEpoch, 60000);
    refreshEpoch();
});

// ─── SSE Connection ─────────────────────────────────────

function connectSSE() {
    if (evtSource) evtSource.close();
    evtSource = new EventSource(`${API}/api/events`);

    evtSource.onmessage = (e) => {
        try {
            const data = JSON.parse(e.data);
            if (data.type === 'log') appendLog(data.entry);
            if (data.type === 'state') updateState(data);
            if (data.type === 'pipeline') updatePipeline(data);
        } catch { }
    };

    evtSource.onerror = () => {
        setTimeout(connectSSE, 3000);
    };
}

// ─── State Management ───────────────────────────────────

function updateState(data) {
    // Status badge
    const badge = document.getElementById('statusBadge');
    if (badge && data.state) {
        badge.textContent = data.state;
        badge.className = 'status-badge status-' + data.state.toLowerCase().replace(/_/g, '-');
    }

    // Wallet
    if (data.walletAddress) {
        const el = document.getElementById('walletAddress');
        if (el) el.textContent = data.walletAddress;
    }

    // Stats
    if (data.stats) {
        const s = data.stats;
        setVal('statAttempted', s.challengesAttempted || 0);
        setVal('statPassed', s.challengesPassed || 0);
        setVal('statFailed', s.challengesFailed || 0);
        setVal('statCredits', s.creditsEarned || 0);
        setVal('statReceipts', s.receiptsPosted || 0);
        setVal('statEpoch', s.currentEpoch || '—');
        setVal('statLifetimePassed', s.lifetimePassed || 0);
        setVal('statLifetimeCredits', s.lifetimeCredits || 0);

        // Success rate
        const total = (s.challengesPassed || 0) + (s.challengesFailed || 0);
        const rate = total > 0 ? Math.round(100 * s.challengesPassed / total) : 0;
        setVal('statSuccessRate', rate + '%');
    }

    // Credits
    if (data.credits?.lastBalance !== undefined) {
        setVal('creditBalance', '$' + data.credits.lastBalance.toFixed(2));
    }

    // Session info
    if (data.sessionId) sessionId = data.sessionId;
    if (data.hasApiKey !== undefined) {
        const apiSection = document.getElementById('apiKeySection');
        if (apiSection) apiSection.style.display = data.hasApiKey ? 'none' : 'block';
    }

    // Multi-user stats
    if (data.activeSessions !== undefined) setVal('activeSessions', data.activeSessions);
    if (data.runningMiners !== undefined) setVal('runningMiners', data.runningMiners);

    // Buttons
    updateButtons(data.state, data.isRunning);
}

function setVal(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
}

function updateButtons(state, isRunning) {
    const start = document.getElementById('btnStart');
    const stop = document.getElementById('btnStop');
    if (start) start.disabled = isRunning;
    if (stop) stop.disabled = !isRunning;
}

function updatePipeline(data) {
    const stages = ['extract', 'verify', 'constraints', 'artifact'];
    stages.forEach((name, i) => {
        const el = document.getElementById(`stage-${name}`);
        if (!el) return;
        if (data.stage === null) {
            el.className = 'pipeline-stage done';
        } else if (data.stage === i + 1) {
            el.className = 'pipeline-stage active';
        } else if (data.stage > i + 1) {
            el.className = 'pipeline-stage done';
        } else {
            el.className = 'pipeline-stage';
        }
    });
    const detail = document.getElementById('pipelineDetail');
    if (detail && data.detail) detail.textContent = data.detail;
}

// ─── Uptime Timer ───────────────────────────────────────

function startUptimeTimer() {
    if (uptimeTimer) clearInterval(uptimeTimer);
    uptimeTimer = setInterval(() => {
        if (!uptimeStart) return;
        const el = document.getElementById('statUptime');
        if (!el) return;
        const ms = Date.now() - uptimeStart;
        const h = Math.floor(ms / 3600000);
        const m = Math.floor((ms % 3600000) / 60000);
        const s = Math.floor((ms % 60000) / 1000);
        el.textContent = `${h}h ${m}m ${s}s`;
    }, 1000);
}

// ─── Log Viewer ─────────────────────────────────────────

function appendLog(entry) {
    const lc = document.getElementById('logContainer');
    const div = document.createElement('div');
    div.className = `log-entry ${entry.level}`;

    const time = new Date(entry.timestamp).toLocaleTimeString('en-US', { hour12: false });
    const icons = { info: 'ℹ', warn: '⚠', error: '✖', success: '✔', debug: '…' };

    div.innerHTML = `
    <span class="log-time">${time}</span>
    <span class="log-icon">${icons[entry.level] || '•'}</span>
    <span class="log-source">${entry.source}</span>
    <span class="log-msg">${escapeHtml(entry.message)}</span>
  `;

    lc.appendChild(div);
    logCount++;

    while (lc.children.length > 500) lc.removeChild(lc.firstChild);
    if (autoScroll) lc.scrollTop = lc.scrollHeight;
}

function clearLogs() {
    document.getElementById('logContainer').innerHTML = '';
    logCount = 0;
}

function toggleAutoScroll() {
    autoScroll = !autoScroll;
    const btn = document.getElementById('btnAutoScroll');
    btn.style.opacity = autoScroll ? '1' : '0.5';
}

function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
}

// ─── API Calls ──────────────────────────────────────────

function headers() {
    const h = { 'Content-Type': 'application/json' };
    if (sessionId) h['X-Session-Id'] = sessionId;
    return h;
}

async function refreshStatus() {
    try {
        const res = await fetch(`${API}/api/status`);
        const data = await res.json();
        updateState(data);
        if (data.stats?.startedAt && data.isRunning) {
            uptimeStart = new Date(data.stats.startedAt).getTime();
        } else {
            uptimeStart = null;
        }
        if (data.model) {
            const sel = document.getElementById('modelSelect');
            if (sel && sel.value !== data.model) sel.value = data.model;
        }
    } catch { }
}

async function refreshEpoch() {
    try {
        const res = await fetch(`${API}/api/epochs`);
        const data = await res.json();
        if (data.epoch) {
            setVal('epochId', data.epoch.epochId || '—');
            if (data.epoch.nextEpochStartTimestamp) {
                setVal('epochEnds', new Date(data.epoch.nextEpochStartTimestamp * 1000).toLocaleTimeString());
            }
        }
    } catch { }
}

async function setApiKey() {
    const input = document.getElementById('apiKeyInput');
    const key = input?.value?.trim();
    if (!key) return;

    const btn = document.getElementById('btnSetKey');
    if (btn) { btn.disabled = true; btn.textContent = 'Connecting...'; }

    try {
        const res = await fetch(`${API}/api/apikey`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key })
        });
        const data = await res.json();
        if (data.ok) {
            sessionId = data.sessionId;
            appendLog({ timestamp: new Date().toISOString(), level: 'success', source: 'ui', message: `Connected! Wallet: ${data.walletAddress}` });
            // Reconnect SSE for this session
            connectSSE();
            setTimeout(refreshStatus, 1000);
        } else {
            appendLog({ timestamp: new Date().toISOString(), level: 'error', source: 'ui', message: `API Key error: ${data.error}` });
        }
    } catch (e) {
        appendLog({ timestamp: new Date().toISOString(), level: 'error', source: 'ui', message: `Connection failed: ${e.message}` });
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Connect'; }
    }
}

async function startMining() {
    const model = document.getElementById('modelSelect').value;
    const stakeAmount = document.getElementById('stakeTier').value;
    const autoFund = document.getElementById('autoFundToggle')?.checked !== false;
    const verifyModel = verifyEnabled ? document.getElementById('verifyModelSelect').value : null;
    try {
        await fetch(`${API}/api/start`, {
            method: 'POST',
            headers: headers(),
            body: JSON.stringify({ model, verifyModel, verifyEnabled, autoFund, stakeAmount })
        });
        uptimeStart = Date.now();
    } catch (e) {
        appendLog({ timestamp: new Date().toISOString(), level: 'error', source: 'ui', message: `Start failed: ${e.message}` });
    }
}

async function stopMining() {
    try {
        await fetch(`${API}/api/stop`, { method: 'POST', headers: headers() });
        uptimeStart = null;
    } catch { }
}

async function claimRewards() {
    try {
        appendLog({ timestamp: new Date().toISOString(), level: 'info', source: 'ui', message: 'Claiming rewards...' });
        await fetch(`${API}/api/claim`, { method: 'POST', headers: headers() });
    } catch { }
}

async function testSolve() {
    try {
        appendLog({ timestamp: new Date().toISOString(), level: 'info', source: 'ui', message: 'Starting test solve...' });
        const res = await fetch(`${API}/api/test-solve`, { method: 'POST', headers: headers() });
        const data = await res.json();
        if (data.ok) {
            appendLog({ timestamp: new Date().toISOString(), level: 'success', source: 'ui', message: `Test solve complete! Epoch: ${data.epochId}, Credits/solve: ${data.creditsPerSolve}` });
        } else {
            appendLog({ timestamp: new Date().toISOString(), level: 'error', source: 'ui', message: `Test solve failed: ${data.error}` });
        }
    } catch (e) {
        appendLog({ timestamp: new Date().toISOString(), level: 'error', source: 'ui', message: `Test error: ${e.message}` });
    }
}

async function updateModel(model) {
    try {
        const res = await fetch(`${API}/api/config`, {
            method: 'POST', headers: headers(),
            body: JSON.stringify({ model })
        });
        const data = await res.json();
        if (data.ok) {
            appendLog({ timestamp: new Date().toISOString(), level: 'success', source: 'ui', message: `Model → ${data.model}` });
        }
    } catch { }
}

async function loadModels() {
    try {
        const res = await fetch(`${API}/api/models`);
        const models = await res.json();
        const sel = document.getElementById('modelSelect');
        const verifySel = document.getElementById('verifyModelSelect');
        if (!sel || !Array.isArray(models)) return;
        sel.innerHTML = '';
        if (verifySel) verifySel.innerHTML = '';
        models.forEach(m => {
            const opt = document.createElement('option');
            opt.value = m.id;
            opt.textContent = m.label || m.id;
            sel.appendChild(opt);
            // Also populate verify model dropdown
            if (verifySel) {
                const opt2 = document.createElement('option');
                opt2.value = m.id;
                opt2.textContent = m.label || m.id;
                verifySel.appendChild(opt2);
            }
        });
    } catch { }
}

function toggleVerifyModel(enabled) {
    verifyEnabled = enabled;
    const row = document.getElementById('verifyModelRow');
    if (row) row.style.display = enabled ? 'flex' : 'none';
    if (!enabled) {
        // Tell backend to clear verify model (use primary)
        updateVerifyModel(null);
    }
}

async function updateVerifyModel(model) {
    try {
        await fetch(`${API}/api/config`, {
            method: 'POST', headers: headers(),
            body: JSON.stringify({ verifyModel: model || null, verifyEnabled })
        });
        if (model) {
            appendLog({ timestamp: new Date().toISOString(), level: 'success', source: 'ui', message: `Verify model → ${model}` });
        } else {
            appendLog({ timestamp: new Date().toISOString(), level: 'info', source: 'ui', message: 'Verification uses primary model' });
        }
    } catch { }
}

async function logout() {
    try {
        await fetch(`${API}/api/logout`, { method: 'POST', headers: headers() });
        sessionId = null;
        connectSSE();
        refreshStatus();
        const apiSection = document.getElementById('apiKeySection');
        if (apiSection) apiSection.style.display = 'block';
    } catch { }
}
